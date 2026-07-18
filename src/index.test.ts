import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecipe } from "./index.js";

// ============================================================
// Regression: periodic state re-reports must not reset the off-timer
// (a relay that re-publishes "state: ON" every 60s kept the light on forever —
//  same bug fixed in sowel-recipe-motion-light)
// ============================================================

const ZONE = "zone-1";
const LIGHT = "light-1";

/** Minimal event/equipment harness driving a real recipe instance. */
function makeInstanceHarness() {
  const handlers: Record<string, Array<(e: Record<string, unknown>) => void>> = {};
  let lightPhysicallyOn = false; // what the bulb reports
  let motion = false;

  const emit = (type: string, event: Record<string, unknown>) => {
    for (const h of handlers[type] ?? []) h(event);
  };

  const ctx = {
    eventBus: {
      onType(type: string, handler: (e: Record<string, unknown>) => void) {
        (handlers[type] ??= []).push(handler);
        return () => {
          handlers[type] = (handlers[type] ?? []).filter((h) => h !== handler);
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: () => ({
        name: "Light",
        type: "light_dimmable",
        zoneId: ZONE,
        dataBindings: [{ alias: "state" }, { alias: "brightness" }],
        orderBindings: [{ alias: "state" }, { alias: "brightness" }],
      }),
      getByZone: () => [],
      getDataBindingsWithValues: () => [],
      executeOrder: async () => {},
    },
    zoneManager: {
      getById: () => ({ id: ZONE, name: "Zone" }),
      getDescendantIds: (id: string) => [id],
    },
    zoneAggregator: {
      getByZoneId: () => ({ motion, motionSensors: 1, luminosity: null, isDaylight: null }),
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: (() => {
      const m = new Map<string, unknown>();
      return {
        get: (k: string) => (m.has(k) ? m.get(k) : null),
        set: (k: string, v: unknown) => void m.set(k, v),
        delete: (k: string) => void m.delete(k),
        clear: () => m.clear(),
      };
    })(),
    log: () => {},
    helpers: {
      isAnyLightOn: () => lightPhysicallyOn,
      turnOnLights: () => {
        lightPhysicallyOn = true;
        return [];
      },
      turnOffLights: () => {
        lightPhysicallyOn = false;
        return [];
      },
      setLightsBrightness: () => {
        lightPhysicallyOn = true;
        return [];
      },
      parseDuration: (v: unknown) => {
        const m = /^(\d+)(s|m|h)$/.exec(String(v));
        if (!m) throw new Error(`bad duration: ${String(v)}`);
        const n = Number(m[1]);
        return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60000 : n * 3600000;
      },
      formatDuration: (ms: number) => `${ms}ms`,
    },
  };

  return {
    ctx: ctx as unknown as Parameters<ReturnType<typeof createRecipe>["createInstance"]>[1],
    isLightOn: () => lightPhysicallyOn,
    /** Simulate the bulb publishing its state (value unchanged = a heartbeat). */
    reportLight(on: boolean) {
      lightPhysicallyOn = on;
      emit("equipment.data.changed", { equipmentId: LIGHT, alias: "state", value: on ? "ON" : "OFF" });
    },
    emitZone(aggregatedData: Record<string, unknown>) {
      emit("zone.data.changed", { zoneId: ZONE, aggregatedData });
    },
  };
}

describe("periodic light-state re-reports (regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms the off-timer once on external ON and turns off after timeout despite ON heartbeats", () => {
    const h = makeInstanceHarness();
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m", brightness: 100 },
      h.ctx,
    );

    // Light turns on externally, no motion -> off-timer armed for 2m.
    h.reportLight(true);
    expect(h.isLightOn()).toBe(true);

    // 1 minute passes, then the bulb re-publishes "ON" (a heartbeat).
    vi.advanceTimersByTime(60_000);
    h.reportLight(true); // <-- must be ignored, must NOT reset the 2m countdown
    vi.advanceTimersByTime(60_000);

    // 2 minutes total since the real turn-on -> light must be OFF.
    expect(h.isLightOn()).toBe(false);
    inst.stop();
  });
});

describe("empty lux threshold (issue #307 regression)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an empty lux field is treated as 'no threshold', not 0, so a luminosity-reporting sensor still turns on", () => {
    const h = makeInstanceHarness();
    // Empty SEUIL LUX from the UI arrives as "" — Number("") is 0, which used to
    // block any sensor reporting >0 lx (e.g. Sonoff SNZB-03PR2 at 1 lx).
    const inst = createRecipe().createInstance(
      { zone: ZONE, lights: [LIGHT], timeout: "2m", brightness: 100, luxThreshold: "" },
      h.ctx,
    );
    expect(h.isLightOn()).toBe(false);

    h.emitZone({ motion: true, luminosity: 1 });

    expect(h.isLightOn()).toBe(true);
    inst.stop();
  });
});
