import { test, expect } from "bun:test"
import plugin from "../src/index"
import * as pluginModule from "../src/index"
import builtPlugin from "../dist/index.js"
import * as builtPluginModule from "../dist/index.js"

test("public plugin module only exposes a default function export", () => {
  expect(typeof plugin).toBe("function")
  expect(Object.keys(pluginModule)).toEqual(["default"])
})

test("built plugin module only exposes a default function export", () => {
  expect(typeof builtPlugin).toBe("function")
  expect(Object.keys(builtPluginModule)).toEqual(["default"])
})