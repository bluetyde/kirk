import { describe, expect, it } from "vitest";
import { luFactor, luSolve, solve, SplitMix64 } from "./numerics";

describe("SplitMix64", () => {
  it("matches reference 64-bit hex sequences for seed 1", () => {
    const rng = new SplitMix64(1);
    expect(rng.nextU64().toString(16).padStart(16, "0")).toBe("910a2dec89025cc1");
    expect(rng.nextU64().toString(16).padStart(16, "0")).toBe("beeb8da1658eec67");
    expect(rng.nextU64().toString(16).padStart(16, "0")).toBe("f893a2eefb32555e");
  });

  it("matches reference 64-bit hex sequences for seed 2^64 - 1", () => {
    const rng = new SplitMix64(0xffffffffffffffffn);
    expect(rng.nextU64().toString(16).padStart(16, "0")).toBe("e4d971771b652c20");
    expect(rng.nextU64().toString(16).padStart(16, "0")).toBe("e99ff867dbf682c9");
  });

  it("matches reference uniform and normal floats for seed 42", () => {
    const rng = new SplitMix64(42);
    // uniform() twice = 0.7415648787718234, 0.15991039287692016 (exact, compare with ===)
    const u1 = rng.uniform();
    const u2 = rng.uniform();
    expect(u1).toBe(0.7415648787718234);
    expect(u2).toBe(0.15991039287692016);

    // then normal() twice = -0.8918862136277568, 1.7295930879374035 (compare within 1e-14 relative)
    const n1 = rng.normal();
    const n2 = rng.normal();
    expect(Math.abs((n1 - -0.8918862136277568) / -0.8918862136277568)).toBeLessThan(1e-14);
    expect(Math.abs((n2 - 1.7295930879374035) / 1.7295930879374035)).toBeLessThan(1e-14);
  });

  it("allows getting and setting state", () => {
    const rng = new SplitMix64(100);
    const s = rng.state;
    expect(s).toBe(100n);
    rng.nextU64();
    expect(rng.state).not.toBe(100n);
    rng.state = 200n;
    expect(rng.state).toBe(200n);
  });
});

describe("solve and luFactor / luSolve", () => {
  const A = [
    [0, 2, 1],
    [1, 1, 1],
    [2, 3, 1],
  ];
  const b = [5, 6, 11];

  it("solves 3x3 system that requires pivoting", () => {
    const x = solve(A, b);
    for (let i = 0; i < 3; i++) {
      let ax_i = 0;
      for (let j = 0; j < 3; j++) {
        ax_i += A[i]![j]! * x[j]!;
      }
      expect(Math.abs(ax_i - b[i]!)).toBeLessThan(1e-12);
    }
  });

  it("factors and solves with LU decomposition", () => {
    const factored = luFactor(A);
    const x = luSolve(factored, b);
    for (let i = 0; i < 3; i++) {
      let ax_i = 0;
      for (let j = 0; j < 3; j++) {
        ax_i += A[i]![j]! * x[j]!;
      }
      expect(Math.abs(ax_i - b[i]!)).toBeLessThan(1e-12);
    }
  });

  it("throws on singular matrix", () => {
    const singular = [
      [1, 2, 3],
      [2, 4, 6],
      [1, 1, 1],
    ];
    expect(() => solve(singular, [1, 2, 3])).toThrow("singular matrix");
    expect(() => luFactor(singular)).toThrow("singular matrix");
  });
});
