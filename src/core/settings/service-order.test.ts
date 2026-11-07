import { describe, expect, test } from "bun:test";
import { channelBaseName, filterServices, popularServices, servicesToShow } from "./service-order";

// Shaped like TMDB's US list: display order, with storefront channels mixed in
// and the base "HBO Max" ranked far below its Amazon channel.
const US = [
  { id: 8, name: "Netflix" },
  { id: 9, name: "Amazon Prime Video" },
  { id: 337, name: "Disney Plus" },
  { id: 1825, name: "HBO Max Amazon Channel" },
  { id: 15, name: "Hulu" },
  { id: 1853, name: "Paramount Plus Apple TV channel" },
  { id: 386, name: "Peacock Premium" },
  { id: 633, name: "Paramount+ Roku Premium Channel" },
  { id: 191, name: "Kanopy" },
  { id: 1899, name: "HBO Max" },
  { id: 73, name: "Tubi TV" },
];
const names = (list: { name: string }[]) => list.map((s) => s.name);

describe("channelBaseName", () => {
  test("strips the Amazon, Apple TV, and Roku channel suffixes, in any case", () => {
    expect(channelBaseName("HBO Max Amazon Channel")).toBe("HBO Max");
    expect(channelBaseName("ZDFtivi Amazon channel")).toBe("ZDFtivi");
    expect(channelBaseName("Paramount Plus Apple TV Channel")).toBe("Paramount Plus");
    expect(channelBaseName("AMC+ Roku Premium Channel")).toBe("AMC+");
    expect(channelBaseName("XLTV Amazon Channel ")).toBe("XLTV");
  });

  test("leaves other names alone", () => {
    expect(channelBaseName("Netflix")).toBeNull();
    expect(channelBaseName("Channel 4")).toBeNull();
    expect(channelBaseName("The Roku Channel")).toBeNull();
    expect(channelBaseName("Amazon Channel")).toBeNull();
  });
});

describe("popularServices", () => {
  test("takes the first services in display order, skipping storefront channels", () => {
    expect(names(popularServices(US, [], 4))).toEqual(["Netflix", "Amazon Prime Video", "Disney Plus", "HBO Max"]);
  });

  test("a channel ranks its base service at the channel's place", () => {
    expect(names(popularServices(US, [], 6))).toEqual(["Netflix", "Amazon Prime Video", "Disney Plus", "HBO Max", "Hulu", "Peacock Premium"]);
  });

  test("a channel with no base service in the list promotes nothing", () => {
    // "Paramount Plus" and "Paramount+" are not in the list, so their channels just drop out.
    expect(names(popularServices(US, [], 7))).toEqual(["Netflix", "Amazon Prime Video", "Disney Plus", "HBO Max", "Hulu", "Peacock Premium", "Kanopy"]);
  });

  test("a base service already ranked above its channel keeps its own place", () => {
    const list = [
      { id: 1, name: "Starz" },
      { id: 2, name: "Netflix" },
      { id: 3, name: "Starz Amazon Channel" },
    ];
    expect(names(popularServices(list, [], 2))).toEqual(["Starz", "Netflix"]);
  });

  test("kept services outside the group are included, in display order", () => {
    expect(names(popularServices(US, [73, 8], 2))).toEqual(["Netflix", "Amazon Prime Video", "Tubi TV"]);
  });

  test("a kept storefront channel is shown even though channels are skipped", () => {
    expect(names(popularServices(US, [633], 2))).toEqual(["Netflix", "Amazon Prime Video", "Paramount+ Roku Premium Channel"]);
  });

  test("kept ids the country does not list are ignored", () => {
    expect(names(popularServices(US, [999], 1))).toEqual(["Netflix"]);
  });

  test("a short list is returned whole, minus channels", () => {
    expect(popularServices(US).length).toBe(US.length - 3);
  });

  test("defaults to 20 services", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `Service ${i + 1}` }));
    expect(popularServices(many).map((s) => s.id)).toEqual(many.slice(0, 20).map((s) => s.id));
  });
});

describe("filterServices", () => {
  test("matches part of a name, ignoring case and surrounding space", () => {
    expect(names(filterServices(US, "  max "))).toEqual(["HBO Max Amazon Channel", "HBO Max"]);
  });

  test("an empty query matches everything", () => {
    expect(filterServices(US, " ")).toEqual(US);
  });
});

describe("servicesToShow", () => {
  test("a search looks through every service, channels included", () => {
    expect(names(servicesToShow(US, { query: "tubi", showAll: false, keepIds: [] }))).toEqual(["Tubi TV"]);
  });

  test("Show all returns the whole list in display order", () => {
    expect(servicesToShow(US, { query: "", showAll: true, keepIds: [] })).toEqual(US);
  });

  test("otherwise the popular group, with kept services", () => {
    const shown = servicesToShow(US, { query: "", showAll: false, keepIds: [73] });
    expect(shown.at(-1)?.name).toBe("Tubi TV");
    expect(shown.some((s) => s.name.endsWith("Channel"))).toBe(false);
  });
});
