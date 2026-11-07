import { expect, test } from "bun:test";
import { isAuthorizedCronRequest } from "./cron-auth";

test("accepts exactly Bearer <secret>", () => {
  expect(isAuthorizedCronRequest("Bearer s3cret-value", "s3cret-value")).toBe(true);
});

test("rejects a wrong, missing, or differently shaped header", () => {
  for (const header of ["Bearer wrong", "Bearer s3cret-valuE", "s3cret-value", "bearer s3cret-value", "Bearer s3cret-value ", "Bearer ", "", null, undefined]) {
    expect(isAuthorizedCronRequest(header, "s3cret-value")).toBe(false);
  }
});

test("rejects everything when no secret is configured", () => {
  expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
  expect(isAuthorizedCronRequest("Bearer undefined", undefined)).toBe(false);
});
