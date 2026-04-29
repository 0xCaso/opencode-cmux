import { test, expect } from "bun:test"
import { LSOF_LISTEN_RE } from "../src/index"

test("LSOF_LISTEN_RE captures the port from a real lsof line", () => {
  const line =
    "node    12345 kevin   23u  IPv4 0x12345      0t0  TCP *:38421 (LISTEN)"
  expect(line.match(LSOF_LISTEN_RE)?.[1]).toBe("38421")
})

test("LSOF_LISTEN_RE matches localhost and IPv6 forms", () => {
  expect("TCP localhost:4096 (LISTEN)".match(LSOF_LISTEN_RE)?.[1]).toBe("4096")
  expect("TCP [::1]:8080 (LISTEN)".match(LSOF_LISTEN_RE)?.[1]).toBe("8080")
})

test("LSOF_LISTEN_RE does not match non-LISTEN lines", () => {
  expect("TCP *:38421 (ESTABLISHED)".match(LSOF_LISTEN_RE)).toBeNull()
  expect("TCP *:38421".match(LSOF_LISTEN_RE)).toBeNull()
})

// Catches the class of bug from PR #11 review: a one-shot edit injected
// U+200B (zero-width space) into the regex source, silently breaking the
// match. Asserting the source is pure ASCII traps any future invisible-
// character regression at the test layer instead of in production.
test("LSOF_LISTEN_RE source contains only printable ASCII", () => {
  expect(LSOF_LISTEN_RE.source).toMatch(/^[\x20-\x7E]+$/)
})
