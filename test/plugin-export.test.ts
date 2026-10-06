import { test, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import plugin from "../src/index"
import * as pluginModule from "../src/index"

async function loadBuiltPluginModule() {
  const builtPluginPath = new URL("../dist/index.js", import.meta.url)

  // Always rebuild: a stale dist/ would test old code.
  execFileSync("bun", ["run", "build"], { stdio: "ignore" })

  return import(builtPluginPath.href)
}

test("default export is a v1 server() and a v2 setup()", () => {
  expect(plugin).toMatchObject({ id: "opencode-cmux" })
  expect(typeof plugin.server).toBe("function")
  expect(typeof plugin.setup).toBe("function")
  expect(Object.keys(pluginModule)).toEqual(["default"])
})

test("built plugin module exports the same shape", async () => {
  const builtPluginModule = await loadBuiltPluginModule()

  expect(builtPluginModule.default).toMatchObject({ id: "opencode-cmux" })
  expect(typeof builtPluginModule.default.server).toBe("function")
  expect(typeof builtPluginModule.default.setup).toBe("function")
  expect(Object.keys(builtPluginModule)).toEqual(["default"])
})