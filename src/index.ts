interface Gif {
  id: number;
  url: string;
  tags: string;
  width: number;
  height: number;
}

interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
  DISCORD_APP_ID: string;
}

const SITE_URL = "https://gif.land";
const MAX_GIFS_SHOWN = 10;

// --- Discord interaction types ---
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
} as const;

const EPHEMERAL = 1 << 6; // 64

// --- Helpers ---

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchGifs(): Promise<Gif[]> {
  const res = await fetch(`${SITE_URL}/api`);
  if (!res.ok) throw new Error(`Failed to fetch GIFs: ${res.status}`);
  return res.json();
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- Ed25519 signature verification ---

async function verifyDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToUint8Array(publicKey),
    { name: "Ed25519", namedCurve: "Ed25519" },
    false,
    ["verify"],
  );

  const message = new TextEncoder().encode(timestamp + body);
  return crypto.subtle.verify(
    "Ed25519",
    key,
    hexToUint8Array(signature),
    message,
  );
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// --- Build Discord message with embeds + buttons ---

function buildGifPicker(gifs: Gif[], query: string): object {
  const embeds = gifs.map((gif) => {
    const gifUrl = `${SITE_URL}/${gif.url}`;
    return {
      title: `${gif.url}${gif.tags ? ` | ${gif.tags}` : ""}`,
      image: { url: gifUrl },
    };
  });

  // Discord allows max 5 action rows per message.
  // We put 2 buttons per row to fit up to 10 buttons in 5 rows.
  const actionRows: object[] = [];
  for (let i = 0; i < gifs.length; i += 2) {
    const rowButtons = gifs.slice(i, i + 2).map((gif) => {
      const name = gif.url
      return {
        type: 2,
        style: 1,
        label: `Post: ${name}`.slice(0, 80),
        custom_id: `post:${gif.url}||${gif.tags || ""}`.slice(0, 100),
      };
    });
    actionRows.push({ type: 1, components: rowButtons });
  }

  const headerText =
    gifs.length === MAX_GIFS_SHOWN
      ? `Showing ${MAX_GIFS_SHOWN} GIFs for **${query}** — try a more specific search to narrow results.`
      : `Found ${gifs.length} GIF${gifs.length === 1 ? "" : "s"} for **${query}**`;

  return {
    content: headerText,
    embeds,
    components: actionRows,
    flags: EPHEMERAL,
  };
}

function buildSingleGifMessage(gif: Gif): object {
  const gifUrl = `${SITE_URL}/${gif.url}`;
  const label = `${gif.url}${gif.tags ? ` | ${gif.tags}` : ""}`;
  return {
    embeds: [
      {
        title: label,
        image: { url: gifUrl },
      },
    ],
  };
}

// --- Interaction handlers ---

function handlePing(): Response {
  return jsonResponse({ type: InteractionResponseType.PONG });
}

async function handleSlashCommand(
  interaction: Record<string, any>,
): Promise<Response> {
  const options = interaction.data?.options ?? [];
  const searchOption = options.find(
    (o: { name: string }) => o.name === "search",
  );
  const query = (searchOption?.value ?? "").trim();

  let allGifs: Gif[];
  try {
    allGifs = await fetchGifs();
  } catch {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content:
          "Could not reach gif.land right now. Try again in a moment.",
        flags: EPHEMERAL,
      },
    });
  }

  // No search term — post a random GIF publicly
  if (!query) {
    const gif = allGifs[Math.floor(Math.random() * allGifs.length)];
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: buildSingleGifMessage(gif),
    });
  }

  // Search
  const lowerQuery = query.toLowerCase();
  const matches = allGifs.filter(
    (g) =>
      g.tags?.toLowerCase().includes(lowerQuery) ||
      g.url.toLowerCase().includes(lowerQuery),
  );

  if (matches.length === 0) {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `No GIFs found for "${query}". Try a different search.`,
        flags: EPHEMERAL,
      },
    });
  }

  const shown = shuffled(matches).slice(0, MAX_GIFS_SHOWN);
  return jsonResponse({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: buildGifPicker(shown, query),
  });
}

async function handleButtonClick(
  interaction: Record<string, any>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const customId: string = interaction.data?.custom_id ?? "";
  if (!customId.startsWith("post:")) {
    return jsonResponse({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: "Unknown action.", components: [], embeds: [] },
    });
  }

  const payload = customId.slice("post:".length);
  const [gifFilename, tags = ""] = payload.split("||", 2);
  const gif: Gif = { id: 0, url: gifFilename, tags, width: 0, height: 0 };

  // Update the ephemeral message to confirm
  const confirmResponse = jsonResponse({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content: `Posted **${gifFilename}**`,
      embeds: [],
      components: [],
    },
  });

  // Post the GIF publicly via followup webhook
  const token = interaction.token;
  const appId = env.DISCORD_APP_ID;
  ctx.waitUntil(
    fetch(
      `https://discord.com/api/v10/webhooks/${appId}/${token}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildSingleGifMessage(gif)),
      },
    ),
  );

  return confirmResponse;
}

// --- Main handler ---

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const signature = request.headers.get("X-Signature-Ed25519") ?? "";
    const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
    const body = await request.text();

    if (
      !(await verifyDiscordSignature(
        env.DISCORD_PUBLIC_KEY,
        signature,
        timestamp,
        body,
      ))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    switch (interaction.type) {
      case InteractionType.PING:
        return handlePing();

      case InteractionType.APPLICATION_COMMAND:
        return handleSlashCommand(interaction);

      case InteractionType.MESSAGE_COMPONENT:
        return handleButtonClick(interaction, env, ctx);

      default:
        return new Response("Unknown interaction type", { status: 400 });
    }
  },
};
