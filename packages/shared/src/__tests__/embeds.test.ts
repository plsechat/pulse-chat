import { describe, expect, test } from "bun:test";
import {
  GIF_PICKER_MEDIA_HOSTS,
  isBareEmbedLink,
  pickEmbedMedia,
  renderEmbedsAsText
} from "../embeds";

describe("renderEmbedsAsText", () => {
  test("a card renders title — url, description, up to ten fields and the footer; cards are separated by a blank line", () => {
    const text = renderEmbedsAsText(
      [
        {
          type: "rich",
          title: "Server status",
          url: "https://status.example",
          description: "All systems go",
          fields: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, value: `v${i}` })),
          footer: { text: "Updated hourly" }
        },
        { title: "Second card" }
      ],
      10_000
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("Server status — https://status.example");
    expect(lines[1]).toBe("All systems go");
    expect(lines.slice(2, 12)).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}: v${i}`));
    expect(lines[12]).toBe("Updated hourly");
    expect(lines[13]).toBe("");
    expect(lines[14]).toBe("Second card");
    expect(lines).toHaveLength(15);
  });

  test("a url already in the text is not repeated; an unfurl never writes the page's words back", () => {
    const unfurl = { type: "link", url: "https://example.org", title: "Page", description: "Page words" };
    expect(renderEmbedsAsText([unfurl], 1000, "see https://example.org")).toBe("");
    expect(renderEmbedsAsText([unfurl], 1000, "see")).toBe("Page — https://example.org");
    expect(renderEmbedsAsText([{ type: "rich", title: "Card", url: "https://example.org" }], 1000, "https://example.org")).toBe(
      "Card"
    );
  });

  test("control characters are flattened, each part and the total are bounded, junk is ignored", () => {
    const text = renderEmbedsAsText(
      [
        { title: "a\r\nb\tc", description: "d".repeat(2_000), fields: [{ name: "n", value: "" }, { name: "", value: "only value" }] },
        null as unknown as { title: string },
        { fields: [] }
      ],
      500
    );
    expect(text.startsWith("a b c\n")).toBe(true);
    // The description alone is capped at 1000; the total cap wins below that.
    expect(Array.from(text).length).toBe(500);
    expect(Array.from(renderEmbedsAsText([{ description: "d".repeat(2_000) }], 10_000)).length).toBe(1_000);
    expect(renderEmbedsAsText([{ title: "x", fields: [{ name: "n", value: "" }, { name: "", value: "only value" }] }], 100)).toBe(
      "x\nn\nonly value"
    );
    expect(renderEmbedsAsText(undefined, 100)).toBe("");
  });
});

describe("pickEmbedMedia", () => {
  test("a picker GIF is its mp4 from an allowed host, falling back to the still, then the service proxy", () => {
    expect(
      pickEmbedMedia({
        type: "gifv",
        url: "https://tenor.com/view/wave-gif-1",
        thumbnail: { url: "https://media.tenor.com/abc/wave.png" },
        video: { url: "https://media.tenor.com/abc/AAAPo/wave.mp4" }
      })
    ).toEqual({ url: "https://media.tenor.com/abc/AAAPo/wave.mp4", kind: "video", filename: "wave.mp4", mime: "video/mp4" });

    expect(
      pickEmbedMedia({ type: "gifv", url: "https://klipy.com/gif/x", thumbnail: { url: "https://static.klipy.com/ii/a/b/hello.gif" } })
    ).toEqual({ url: "https://static.klipy.com/ii/a/b/hello.gif", kind: "image", filename: "hello.gif", mime: "image/gif" });

    expect(
      pickEmbedMedia({
        type: "gifv",
        video: { url: "https://cdn.example.net/x.mp4", proxy_url: "https://media.discordapp.net/external/abc/https/cdn.example.net/x.mp4" }
      })
    ).toEqual({
      url: "https://media.discordapp.net/external/abc/https/cdn.example.net/x.mp4",
      kind: "video",
      filename: "x.mp4",
      mime: "video/mp4"
    });
  });

  test("other hosts, http, and non-media embed types yield null", () => {
    expect(pickEmbedMedia({ type: "gifv", video: { url: "https://cdn.example.net/x.mp4" } })).toBeNull();
    expect(pickEmbedMedia({ type: "gifv", video: { url: "http://media.tenor.com/x.mp4" } })).toBeNull();
    expect(pickEmbedMedia({ type: "video", video: { url: "https://media.tenor.com/x.mp4" } })).toBeNull();
    expect(pickEmbedMedia({ type: "rich", image: { url: "https://media.tenor.com/x.png" } })).toBeNull();
    expect(pickEmbedMedia({ type: "image", image: { url: "https://media.tenor.com/x.png" } })).toEqual({
      url: "https://media.tenor.com/x.png",
      kind: "image",
      filename: "x.png",
      mime: "image/png"
    });
    expect(GIF_PICKER_MEDIA_HOSTS).toEqual(["media.tenor.com", "c.tenor.com", "static.klipy.com", "static2.klipy.com"]);
  });
});

describe("isBareEmbedLink", () => {
  test("true only when the body is exactly the embed's page link", () => {
    const embed = { type: "gifv", url: "https://tenor.com/view/wave-gif-1" };
    expect(isBareEmbedLink("https://tenor.com/view/wave-gif-1", embed)).toBe(true);
    expect(isBareEmbedLink("  https://tenor.com/view/wave-gif-1 ", embed)).toBe(true);
    expect(isBareEmbedLink("look https://tenor.com/view/wave-gif-1", embed)).toBe(false);
    expect(isBareEmbedLink("", embed)).toBe(false);
    expect(isBareEmbedLink("x", { type: "gifv" })).toBe(false);
  });
});
