import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"
import { isolatedEnv } from "./fixture/environment"

// Each case drives real `serve --service` processes through the real CLI commands and client,
// disrupts them, and then requires the service to settle: exactly one live server, registered and
// answering on the configured port, which `opencode service stop` removes without leftovers.
// Run with `bun run test:service-lifecycle`; it is too slow for the default suite.

const entry = path.join(import.meta.dir, "../src/index.ts")
const serviceTest = process.platform === "win32" ? test.skip : test

serviceTest(
  "concurrent cold starts converge on one server",
  async () => {
    await using home = await serviceHome()

    await Promise.all([
      ...Array.from({ length: 6 }, () => cli(home, "service", "start")),
      ...Array.from({ length: 3 }, () => ensure(home, OPENCODE_VERSION)),
    ])

    await steady(home)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "a restart during concurrent starts leaves only the new server",
  async () => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const before = await settled(home)

    await Promise.all([
      cli(home, "service", "restart"),
      ...Array.from({ length: 4 }, () => cli(home, "service", "start")),
      ...Array.from({ length: 2 }, () => ensure(home)),
    ])

    const after = await steady(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(before.pid)).toBe(false)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "racing restarts leave one server",
  async () => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const before = await settled(home)

    await Promise.all([cli(home, "service", "restart"), cli(home, "service", "restart")])

    const after = await steady(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(before.pid)).toBe(false)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "a crashed server is replaced",
  async () => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const before = await settled(home)

    process.kill(before.pid, "SIGKILL")
    await exited(before.pid)
    await cli(home, "service", "start")

    const after = await steady(home)
    expect(after.pid).not.toBe(before.pid)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "a frozen server is evicted",
  async () => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const before = await settled(home)

    process.kill(before.pid, "SIGSTOP")
    await cli(home, "service", "start")

    const after = await steady(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(before.pid)).toBe(false)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "an upgrade replaces the old server and version-agnostic clients keep the new one",
  async () => {
    await using home = await serviceHome()
    const old = Bun.spawn([process.execPath, "--define", 'OPENCODE_VERSION:"2.0.0-old"', entry, "serve", "--service"], {
      env: home.env,
      stdout: "ignore",
      stderr: "ignore",
    })
    const before = await settled(home, "2.0.0-old")

    await Promise.all([
      ensure(home, OPENCODE_VERSION),
      ...Array.from({ length: 3 }, () => cli(home, "service", "start")),
    ])

    const after = await settled(home)
    expect(after.pid).not.toBe(before.pid)
    await old.exited
    await Promise.all([ensure(home), cli(home, "service", "start"), cli(home, "service", "start")])
    expect((await steady(home)).pid).toBe(after.pid)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "an old-protocol server survives version-agnostic clients and yields to a required version",
  async () => {
    await using home = await serviceHome()
    await using old = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixture/old-protocol-service.ts"),
        home.registration,
        String(home.port),
      ],
      { stdout: "ignore", stderr: "inherit" },
    )
    await until(() => snapshot(home).then((state) => state.info))

    await expect(cli(home, "service", "start")).rejects.toThrow("incompatible health protocol")
    await expect(ensure(home)).rejects.toThrow("incompatible health protocol")
    expect(old.exitCode).toBe(null)

    await ensure(home, OPENCODE_VERSION)
    await old.exited
    await steady(home)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "an unrelated process on the port gets an actionable error, then the service starts",
  async () => {
    await using home = await serviceHome()
    using listener = Bun.serve({ hostname: "127.0.0.1", port: home.port, fetch: () => new Response("unrelated") })

    await expect(cli(home, "service", "start")).rejects.toThrow("already in use by another process")
    expect(await servers()).toEqual([])

    await listener.stop(true)
    await cli(home, "service", "start")
    await steady(home)
    await stopped(home)
  },
  120_000,
)

serviceTest.each(["deleted", "corrupted"])(
  "a start right after the registration is %s replaces the retiring server",
  async (damage) => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const before = await settled(home)

    if (damage === "deleted") await fs.rm(home.registration)
    if (damage === "corrupted") await fs.writeFile(home.registration, "{")
    await cli(home, "service", "start")

    const after = await steady(home)
    expect(after.pid).not.toBe(before.pid)
    expect(alive(before.pid)).toBe(false)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "a server that fails to boot reports the failure without respawning",
  async () => {
    await using home = await serviceHome({ failBoot: true })

    await expect(cli(home, "service", "start")).rejects.toThrow("Background service failed to start")

    const info = await until(() => snapshot(home).then((state) => state.info))
    expect(await servers()).toEqual([info.pid])
    await stopped(home)
  },
  120_000,
)

serviceTest.each([0, 500, 1_000, 1_500, 2_000, 3_000])(
  "a stop %ims into a start ends stopped or settled",
  async (delay) => {
    await using home = await serviceHome()

    const results = await Promise.allSettled([
      cli(home, "service", "start"),
      Bun.sleep(delay).then(() => cli(home, "service", "stop")),
    ])

    expect(results[1].status).toBe("fulfilled")
    await quiescent(home)
    await stopped(home)
  },
  120_000,
)

serviceTest(
  "repeated restarts each leave exactly one new server",
  async () => {
    await using home = await serviceHome()
    await cli(home, "service", "start")
    const pids = [(await settled(home)).pid]

    for (const _ of Array.from({ length: 8 })) {
      await cli(home, "service", "restart")
      pids.push((await settled(home)).pid)
    }

    const final = await steady(home)
    expect(new Set(pids).size).toBe(pids.length)
    expect(pids.filter(alive)).toEqual([final.pid])
    await stopped(home)
  },
  120_000,
)

type Home = Awaited<ReturnType<typeof serviceHome>>
type Snapshot = Awaited<ReturnType<typeof snapshot>>

async function serviceHome(options: { readonly failBoot?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-lifecycle-"))
  const port = await availablePort()
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.writeFile(path.join(root, "config", "service-local.json"), JSON.stringify({ port }))
  // A directory where the database file belongs makes boot fail after the server registers.
  if (options.failBoot) await fs.mkdir(path.join(root, "database"))
  return {
    root,
    port,
    registration: path.join(root, "state", "opencode", "service-local.json"),
    env: Object.fromEntries(
      Object.entries(isolatedEnv(root, options.failBoot ? { OPENCODE_DB: path.join(root, "database") } : {})).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    async [Symbol.asyncDispose]() {
      // Only a failed case leaves servers behind; don't let them leak into the next case.
      ;(await servers()).forEach((pid) => signal(pid, "SIGKILL"))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function cli(home: Home, ...args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], { env: home.env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`opencode ${args.join(" ")} exited ${code}: ${stderr.trim()}`)
  return stdout.trim()
}

function ensure(home: Home, version?: string) {
  return Effect.runPromise(
    Service.ensure({
      file: home.registration,
      version,
      command: [process.execPath, entry, "serve", "--service"],
      env: home.env,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )
}

/** One live server, registered and ready with the expected version on the configured port. */
async function settled(home: Home, version = OPENCODE_VERSION) {
  const state = await observe(home, (state) => isSettled(home, state, version))
  if (state.info === undefined) throw new Error("Settled service has no registration")
  return state.info
}

/** Settled, and still the same server after its registration self-check has run. */
async function steady(home: Home, version = OPENCODE_VERSION) {
  const info = await settled(home, version)
  await Bun.sleep(5_500)
  const state = await snapshot(home)
  expect({ settled: isSettled(home, state, version), id: state.info?.id }).toEqual({ settled: true, id: info.id })
  return info
}

/** The service either settled or stopped completely. */
function quiescent(home: Home) {
  return observe(
    home,
    (state) => isSettled(home, state, OPENCODE_VERSION) || (state.info === undefined && state.servers.length === 0),
  )
}

function isSettled(home: Home, state: Snapshot, version: string) {
  return (
    state.info !== undefined &&
    state.info.version === version &&
    new URL(state.info.url).port === String(home.port) &&
    state.answer?.pid === state.info.pid &&
    state.servers.length === 1 &&
    state.servers[0] === state.info.pid
  )
}

async function observe(home: Home, accept: (state: Snapshot) => boolean) {
  const deadline = Date.now() + 30_000
  while (true) {
    const state = await snapshot(home)
    if (accept(state)) return state
    if (Date.now() >= deadline) throw new Error(`Service did not settle: ${JSON.stringify(state)}`)
    await Bun.sleep(100)
  }
}

async function until<A>(read: () => Promise<A | undefined>, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (true) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(50)
  }
}

/** `opencode service stop` leaves no server, no state files, and a free port. */
async function stopped(home: Home) {
  await cli(home, "service", "stop")
  // Allow the OS a moment to reap exited processes; `stop` itself waits for the owner to exit.
  await until(async () => ((await servers()).length === 0 ? true : undefined), 2_000).catch(() => undefined)
  expect(await servers()).toEqual([])
  expect(await fs.readdir(path.dirname(home.registration)).catch(() => [])).toEqual([])
  const server = Bun.serve({ hostname: "127.0.0.1", port: home.port, fetch: () => new Response() })
  await server.stop(true)
}

async function snapshot(home: Home) {
  const info = await Bun.file(home.registration)
    .json()
    .then(Schema.decodeUnknownPromise(Service.Info))
    .catch(() => undefined)
  const answer =
    info === undefined
      ? undefined
      : await fetch(new URL("/api/info", info.url), {
          headers: Service.headers({
            url: info.url,
            auth:
              info.password === undefined
                ? undefined
                : { type: "basic", username: "opencode", password: info.password },
          }),
          signal: AbortSignal.timeout(1_000),
        })
          // Starting, stopping, and failed servers also report their PID, with a non-200 status.
          .then((response) => (response.ok ? (response.json() as Promise<{ readonly pid?: number }>) : undefined))
          .catch(() => undefined)
  return { info, answer, servers: await servers() }
}

/** Every live `serve --service` process started from this checkout, by any client or test. */
async function servers() {
  const output = await Bun.$`pgrep -f ${entry + " serve --service"}`.nothrow().quiet().text()
  return output.split("\n").filter(Boolean).map(Number)
}

async function exited(pid: number) {
  const deadline = Date.now() + 10_000
  while (alive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit`)
    await Bun.sleep(25)
  }
}

function alive(pid: number) {
  return signal(pid, 0)
}

function signal(pid: number, value: NodeJS.Signals | 0) {
  try {
    process.kill(pid, value)
    return true
  } catch {
    return false
  }
}

async function availablePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error("Server did not bind a port")
  return port
}
