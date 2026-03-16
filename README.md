# Eien Saga — Discord Combat Tracker

A Discord bot for tracking player resources during Eien Saga playtests. Handles HP, MP, IP, Armor, Barrier, and Overdrive — with the three-layer damage cascade built in.

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → **Reset Token**, copy your token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**

### 2. Invite the Bot

1. Go to **OAuth2 → URL Generator**
2. Select scopes: `bot`
3. Select permissions: **Send Messages**, **Embed Links**, **Read Message History**, **Manage Messages**
4. Open the generated URL, select your server, authorize

### 3. Install and Run

```bash
npm install
```

Create a `.env` file:

```
DISCORD_TOKEN=your_token_here
DATABASE_URL=your_postgres_url_here   # optional — omit to use in-memory only
```

```bash
node bot-prefix.js
```

---

## Commands

All commands use the `$` prefix.

### Setup

| Command | Description |
|---|---|
| `$set <name> <hp> <mp> <ip> <armor> <barrier>` | Set your character stats manually |
| `$set <google_sheets_url>` | Import character from Google Sheets (sheet must be public) |
| `$view` / `$view @player` | View a character's current resources |

### Resources

| Command | Description |
|---|---|
| `$hp <±amount\|full\|zero>` | Adjust HP directly (no cascade) |
| `$mp <±amount\|full\|zero>` | Adjust MP |
| `$ip <±amount\|full\|zero>` | Adjust IP |
| `$armor <±amount\|full\|zero>` | Adjust Armor |
| `$barrier <±amount\|full\|zero>` | Adjust Barrier |
| `$defend` | Add max Armor + Barrier to current values |
| `$turn [@player]` | Reset Armor + Barrier to 0 (start of turn) |
| `$rest` | Restore HP + MP to max, clear Armor + Barrier |

### Damage

| Command | Description |
|---|---|
| `$dmg <amount> [a\|b\|t] [@target]` | Apply damage through the three-layer cascade |
| `$a <d1> <d2> <mod> <gate>` | Roll an attack and calculate damage |
| `$ga <d1> <d2> <mod> <gate> @targets [type]` | GM attack — tagged players click Defend or Take Damage |

**Damage types:** `a` = armor (default), `b` = barrier, `t` = true damage

**`$dmg` cascade:** Armor/Barrier absorbs damage first. Any overflow hits HP directly. True damage bypasses both.

**`$ga` buttons:** Only the @mentioned targets can click Defend or Take Damage. Clicking Defend applies your max Armor + Barrier before absorbing the hit.

### Overdrive (Shared Pool)

| Command | Description |
|---|---|
| `$overdrive` / `$od` | View current Overdrive |
| `$od +1` / `$od -2` | Adjust Overdrive |
| `$od zero` | Reset to 0 |

Overdrive is capped at 6. It resets when a clash starts or ends. It's always visible in `$clash list`.

### Clash

| Command | Description |
|---|---|
| `$clash start` | Start an encounter (resets Overdrive) |
| `$clash join` | Add yourself to the current clash |
| `$clash add @players` | GM adds players to the clash |
| `$clash list` | Show all combatants + current Overdrive |
| `$clash end` | End the encounter |
| `$round` | New round — clears all Armor/Barrier, resets turn tracker |

---

## Notes

- Character data persists in PostgreSQL if `DATABASE_URL` is set; otherwise resets on restart
- Clash state (combatants, Overdrive, turn tracking) is in-memory and resets on restart
- Google Sheets import reads from specific cell ranges matching the Eien Saga character sheet template
