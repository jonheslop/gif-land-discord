/**
 * One-time script to register the /gifland slash command with Discord.
 *
 * Usage:
 *   DISCORD_APP_ID=... DISCORD_TOKEN=... npx tsx src/register.ts
 *
 * Or with npm script:
 *   DISCORD_APP_ID=... DISCORD_TOKEN=... npm run register
 */

const APP_ID = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_TOKEN;

if (!APP_ID || !TOKEN) {
  console.error(
    "Missing env vars. Set DISCORD_APP_ID and DISCORD_TOKEN before running.",
  );
  process.exit(1);
}

const command = {
  name: "gifland",
  description: "Search and post a GIF from gif.land",
  options: [
    {
      name: "search",
      description: "Search term to filter GIFs (leave empty for random)",
      type: 3, // STRING
      required: false,
    },
  ],
};

async function main() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${TOKEN}`,
    },
    body: JSON.stringify([command]),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Failed to register command: ${res.status} ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log("Command registered successfully:", JSON.stringify(data, null, 2));
}

main();
