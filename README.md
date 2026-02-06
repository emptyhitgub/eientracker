# Discord Resource Tracker Bot

A Discord bot for tracking player resources (HP, MP, IP, Armor, Barrier) during game playtests.

## Setup Instructions

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" tab on the left
4. Click "Add Bot"
5. Under "TOKEN", click "Reset Token" and copy it (you'll need this!)
6. Scroll down to "Privileged Gateway Intents" and enable:
   - Server Members Intent (optional, but recommended)
   - Message Content Intent (optional)

### 2. Get Your Client ID

1. In the Discord Developer Portal, go to the "OAuth2" tab
2. Copy your "CLIENT ID"

### 3. Invite the Bot to Your Server

1. In the Developer Portal, go to "OAuth2" → "URL Generator"
2. Select these scopes:
   - `bot`
   - `applications.commands`
3. Select these bot permissions:
   - Send Messages
   - Use Slash Commands
   - Embed Links
4. Copy the generated URL at the bottom and open it in your browser
5. Select your server and authorize the bot

### 4. Install Node.js

If you don't have Node.js installed:
- Download from [nodejs.org](https://nodejs.org/) (get the LTS version)
- Install it on your computer

### 5. Set Up the Bot Files

1. Download these bot files to a folder on your computer
2. Open `bot.js` in a text editor
3. Replace these two lines near the top:
   ```javascript
   const TOKEN = 'YOUR_BOT_TOKEN_HERE'; // Replace with your bot token from step 1
   const CLIENT_ID = 'YOUR_CLIENT_ID_HERE'; // Replace with your client ID from step 2
   ```

### 6. Install Dependencies

1. Open a command prompt/terminal in the bot folder
2. Run: `npm install`

### 7. Run the Bot

1. In the command prompt/terminal, run: `npm start`
2. You should see "Resource Tracker Bot is online!"
3. Keep this window open while you want the bot running

## Commands

### For Game Masters (requires Manage Messages permission):

- `/set @player hp mp ip armor barrier` - Set all resources for a player
  - Example: `/set @John 100 50 10 5 20`

- `/reset` - Clear all player data

### For Everyone:

- `/view [@player]` - View resources (leave empty to view your own)
  - Example: `/view` or `/view @John`

- `/update @player resource amount` - Add or subtract from a resource
  - Example: `/update @John HP -10` (removes 10 HP)
  - Example: `/update @John MP 5` (adds 5 MP)

- `/listall` - See all players and their resources at once

## Tips

- The bot stores data in memory, so restarting it will clear all player data
- Only users with "Manage Messages" permission can use `/set` and `/reset`
- Use negative numbers in `/update` to subtract resources
- Resources can go negative if needed

## Troubleshooting

**Bot isn't responding:**
- Make sure the bot is online (green status)
- Check that it has permission to send messages in the channel
- Wait a minute after starting the bot for commands to register

**Commands not showing up:**
- Make sure you invited the bot with the `applications.commands` scope
- Restart Discord (close and reopen)
- Check that CLIENT_ID is correct in bot.js

**Bot keeps disconnecting:**
- Make sure your TOKEN is correct
- Check your internet connection
- Keep the terminal window open

## Stopping the Bot

Press `Ctrl+C` in the terminal window where the bot is running.

## Notes

- Data resets when you restart the bot (this is by design for playtesting)
- If you need persistent data across restarts, let me know and I can add database support!
