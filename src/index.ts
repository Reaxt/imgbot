import { Client, GatewayIntentBits } from "discord.js";
import * as mc from "miniclap";
import axios from "axios";
import sharp, { RGBA } from "sharp";
import Color from "color";
import { inspect } from "node:util";

const positiveInteger: mc.Parser<number> = (input) => {
  const num = Number(input);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new mc.ParseError(`'${input}' is not a positive integer.`);
  }
  return num;
};

const colour: mc.Parser<RGBA> = (input) => {
  try {
    return new Color(input).rgb().object();
  } catch {
    throw new mc.ParseError(`'${input}' is not a valid color.`);
  }
};

const axis: mc.Parser<"x" | "y"> = (input) => {
  const a = input.toLowerCase();
  if (!["x", "y"].includes(a)) {
    throw new mc.ParseError(`'${input}' is not a valid axis.`);
  }
  return a as "x" | "y";
};

const formats = ["png", "jpeg", "webp", "gif"] as const;
type Format = typeof formats[number];
const format: mc.Parser<Format> = (input) => {
  const f = input.toLowerCase() as Format;
  if (!formats.includes(f)) {
    throw new mc.ParseError(
      `'${input}' is not a valid format. Available formats are: ${formats
        .map((f) => `'${f}'`)
        .join(", ")}.`
    );
  }
  return f;
};

const box: mc.Parser<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}> = (input) => {
  try {
    const [left, top, right, bottom] = input.split(";").map(positiveInteger);
    return { left, top, right, bottom };
  } catch {
    throw new mc.ParseError(
      `'${input}' is not a valid box specification. Format is 'left;top;right;bottom'.`
    );
  }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
client.once("ready", () => {
  console.log(`logged in as ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("imgbot")) return;

  const command = message.content.split(" ").slice(1);
  const [args, error, help] = mc.parse(command, {
    format: { type: format },
    input: { optional: true },
    removeAlpha: { long: "remove-alpha", type: mc.types.bool },
    ensureAlpha: { long: "ensure-alpha", type: mc.types.bool },
    crop: { short: "c", long: "crop", type: box, optional: true },
    flip: { short: "f", long: "flip", type: axis, optional: true },
    sharpen: { long: "sharpen", type: mc.types.bool },
    threshold: { long: "threshold", type: mc.types.number, optional: true },
    negative: { long: ["negative", "negate"], type: mc.types.bool },
    blur: { long: "blur", type: mc.types.bool },
    tint: { short: "t", long: "tint", type: colour, optional: true },
    greyscale: {
      short: "g",
      long: ["greyscale", "grayscale"],
      type: mc.types.bool,
    },
    width: { short: "w", long: "width", type: positiveInteger, optional: true },
    height: {
      short: "h",
      long: "height",
      type: positiveInteger,
      optional: true,
    },
    rotation: {
      short: "r",
      long: ["rotation", "rotate"],
      type: mc.types.number,
      optional: true,
    },
    extend: {
      short: "e",
      long: ["extend", "pad"],
      type: box,
      optional: true,
    },
    background: {
      short: "b",
      long: "background",
      type: colour,
      optional: true,
    },
  });

  if (["help", "--help", "?"].includes(command[0])) {
    const helpMessage =
      "```\n" +
      `imgbot ${help.params.join(" ")}\n  ${help.options.join("\n  ")}` +
      "\n```";
    await message.reply(helpMessage);
    return;
  }

  if (error) {
    const errorMessage =
      "```\n" +
      [
        ...Object.entries(error.invalid).map(([k, v]) => `Invalid ${k}: ${v}`),
        ...error.missing.map((a) => `Missing argument ${a}.`),
        ...error.unexpected.map((a) => `Unexpected argument '${a}'.`),
      ].join("\n") +
      "\n```";
    await message.reply(errorMessage);
    return;
  }
  if (!args.input && message.attachments.size !== 1) {
    await message.reply("Exactly one image must be attached.");
    return;
  }

  await message.channel.sendTyping();

  try {
    args.input ??= message.attachments.first()!.url;
    const response = await axios.get(args.input, {
      responseType: "arraybuffer",
      maxContentLength: Number(process.env.MAX_CONTENT_LENGTH) || 10_000_000,
    });
    const image = Buffer.from(response.data);

    let pipeline = sharp(image);
    if (args.removeAlpha) {
      pipeline = pipeline.removeAlpha();
    } else if (args.ensureAlpha) {
      pipeline = pipeline.ensureAlpha();
    }
    if (args.crop) {
      const metadata = await pipeline.metadata();
      const { left, top, right, bottom } = args.crop;
      pipeline = pipeline.extract({
        left,
        top,
        width: metadata.width! - left - right,
        height: metadata.height! - top - bottom,
      });
    }
    if (args.flip === "x") {
      pipeline = pipeline.flop();
    } else if (args.flip === "y") {
      pipeline = pipeline.flip();
    }
    if (args.sharpen) {
      pipeline = pipeline.sharpen();
    }
    if (args.threshold != undefined) {
      pipeline = pipeline.threshold(args.threshold);
    }
    if (args.negative) {
      pipeline = pipeline.negate();
    }
    if (args.blur) {
      pipeline = pipeline.blur();
    }
    if (args.tint) {
      pipeline = pipeline.tint(args.tint);
    } else if (args.greyscale) {
      pipeline = pipeline.greyscale();
    }
    if (args.width != undefined || args.height != undefined) {
      pipeline = pipeline.resize(args.width, args.height, { fit: "fill" });
    }
    if (args.rotation != undefined) {
      pipeline = pipeline.rotate(args.rotation, {
        background: args.background,
      });
    }
    if (args.extend) {
      const { left, top, right, bottom } = args.extend;
      pipeline = pipeline.extend({
        left,
        top,
        right,
        bottom,
        background: args.background,
      });
    }

    let filename = "img";
    switch (args.format) {
      case "png": {
        filename += ".png";
        pipeline = pipeline.png();
        break;
      }
      case "jpeg": {
        filename += ".jpg";
        pipeline = pipeline.jpeg();
        break;
      }
      case "webp": {
        filename += ".webp";
        pipeline = pipeline.webp();
        break;
      }
      case "gif": {
        filename += ".gif";
        pipeline = pipeline.gif();
        break;
      }
    }

    const output = await pipeline.toBuffer();
    await message.reply({
      content:
        "```js\n" +
        inspect(
          Object.fromEntries(
            Object.entries(args).filter(([, v]) => v !== false)
          )
        ) +
        "\n```",
      files: [{ name: filename, attachment: output }],
    });
  } catch (err) {
    console.error(err);
    await message.reply("Invalid image or options.");
  }
});

client.login(process.env.DISCORD_TOKEN);
