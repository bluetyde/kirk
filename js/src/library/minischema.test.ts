import { commandSchema, librarySchema, snapshotSchema } from "../schemas.js";
import { describe, expect, it } from "vitest";
import { checkSchema, SchemaError, Validator } from "./minischema.js";

describe("minischema", () => {
  it("passes checkSchema for all three repo schemas", () => {
    expect(() => checkSchema(librarySchema)).not.toThrow();
    expect(() => checkSchema(commandSchema)).not.toThrow();
    expect(() => checkSchema(snapshotSchema)).not.toThrow();
  });

  it("unsupported keyword is rejected with SchemaError", () => {
    expect(() =>
      checkSchema({ type: "object", properties: { a: { oneOf: [] } } }),
    ).toThrow(SchemaError);
  });

  it("non-local $ref throws SchemaError", () => {
    const v = new Validator({
      type: "object",
      properties: { a: { $ref: "https://example.com/other.json" } },
    });
    expect(() => v.errors({ a: 1 })).toThrow(SchemaError);
  });

  it("basic rules", () => {
    const v = new Validator({
      type: "object",
      required: ["n"],
      additionalProperties: false,
      properties: { n: { type: "number", exclusiveMinimum: 0 } },
    });
    expect(v.errors({ n: 1 })).toEqual([]);
    expect(v.errors({ n: 0 }).length).toBeGreaterThan(0);
    expect(v.errors({ n: true }).length).toBeGreaterThan(0); // booleans aren't numbers
    expect(v.errors({ n: Number.NaN }).length).toBeGreaterThan(0); // nor is NaN
    expect(v.errors({}).length).toBeGreaterThan(0);
    expect(v.errors({ n: 1, extra: 2 }).length).toBeGreaterThan(0);
  });

  it("anyOf", () => {
    const v = new Validator({ anyOf: [{ type: "null" }, { type: "string" }] });
    expect(v.errors(null)).toEqual([]);
    expect(v.errors("x")).toEqual([]);
    expect(v.errors(3).length).toBeGreaterThan(0);
  });

  it("javascript parity", () => {
    expect(new Validator({ const: 1 }).errors(true).length).toBeGreaterThan(0);
    expect(new Validator({ enum: [0, "a"] }).errors(false).length).toBeGreaterThan(0);
    expect(new Validator({ const: true }).errors(1).length).toBeGreaterThan(0);
    expect(new Validator({ const: 1 }).errors(1.0)).toEqual([]);
    expect(
      new Validator({ enum: [[1, { a: true }]] }).errors([1.0, { a: true }]),
    ).toEqual([]);
    expect(
      new Validator({ enum: [[1, { a: true }]] }).errors([1, { a: 1 }]).length,
    ).toBeGreaterThan(0);

    const v = new Validator({ type: "string", pattern: "^[a-z]+$" });
    expect(v.errors("core")).toEqual([]);
    expect(v.errors("core\n").length).toBeGreaterThan(0);

    expect(
      new Validator({ type: "string", pattern: "a\\$" }).errors("a$"),
    ).toEqual([]);
    expect(
      new Validator({ type: "string", minLength: 2 }).errors("\u{1F600}a"),
    ).toEqual([]);
    expect(
      new Validator({ type: "string", minLength: 2 }).errors("\u{1F600}").length,
    ).toBeGreaterThan(0);
  });
});
