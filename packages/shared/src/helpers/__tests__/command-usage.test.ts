import { describe, expect, test } from "bun:test";
import {
  argToken,
  commandSignature,
  commandUsage,
  listedSubcommands,
  subcommandSignature,
} from "../command-usage";
import type { TSubcommandDefinition } from "../../plugins";

const subcommands: TSubcommandDefinition[] = [
  {
    name: "play",
    description: "Play a link, or resume",
    args: [{ name: "link", type: "string", placeholder: "YouTube link" }],
  },
  { name: "pause", description: "Pause for everyone" },
  {
    name: "seek",
    description: "Jump to a position",
    args: [{ name: "seconds", type: "number", required: true }],
  },
  { name: "watching", hidden: true, args: [{ name: "channelId", type: "number" }] },
];

describe("command-usage", () => {
  test("an argument token marks required and optional", () => {
    expect(argToken({ name: "who", type: "string", required: true })).toBe("<who>");
    expect(argToken({ name: "who", type: "string" })).toBe("[who]");
  });

  test("hidden sub-commands are never listed", () => {
    expect(listedSubcommands({ subcommands }).map((s) => s.name)).toEqual([
      "play",
      "pause",
      "seek",
    ]);
    expect(listedSubcommands({})).toEqual([]);
  });

  test("a plain command's signature lists its arguments", () => {
    expect(
      commandSignature({
        name: "greet",
        args: [
          { name: "who", type: "string", required: true },
          { name: "times", type: "number" },
        ],
      })
    ).toBe("/greet <who> [times]");
    expect(commandSignature({ name: "ping" })).toBe("/ping");
  });

  test("a command with sub-commands shows the verbs it offers", () => {
    expect(commandSignature({ name: "watch", subcommands })).toBe(
      "/watch play | pause | seek"
    );
  });

  test("a sub-command's signature carries its own arguments", () => {
    expect(subcommandSignature({ name: "watch" }, subcommands[0]!)).toBe(
      "/watch play [link]"
    );
    expect(subcommandSignature({ name: "watch" }, subcommands[1]!)).toBe(
      "/watch pause"
    );
    expect(subcommandSignature({ name: "watch" }, subcommands[2]!)).toBe(
      "/watch seek <seconds>"
    );
  });

  test("the usage reply lists every visible verb with its description", () => {
    expect(commandUsage({ name: "watch", subcommands })).toBe(
      [
        "Usage: /watch <play | pause | seek>",
        "/watch play [link] — Play a link, or resume",
        "/watch pause — Pause for everyone",
        "/watch seek <seconds> — Jump to a position",
      ].join("\n")
    );
  });
});
