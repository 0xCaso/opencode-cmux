import { test, expect } from "bun:test"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import plugin from "../src/index"
import * as pluginModule from "../src/index"

async function loadBuiltPluginModule() {
  const builtPluginPath = new URL("../dist/index.js", import.meta.url)

  if (!existsSync(builtPluginPath)) {
    execFileSync("bun", ["run", "build"], { stdio: "inherit" })
  }

  return import("../dist/index.js")
}

test("public plugin module only exposes a default function export", () => {
  expect(typeof plugin).toBe("function")
  expect(Object.keys(pluginModule)).toEqual(["default"])
})

test("built plugin module only exposes a default function export", async () => {
  const builtPluginModule = await loadBuiltPluginModule()

  expect(typeof builtPluginModule.default).toBe("function")
  expect(Object.keys(builtPluginModule)).toEqual(["default"])
})