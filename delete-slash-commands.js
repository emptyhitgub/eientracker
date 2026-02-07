const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    
    try {
        console.log('🗑️ Deleting all slash commands...');
        
        // Delete global commands
        await client.application.commands.set([]);
        console.log('✅ Deleted all global slash commands');
        
        // Delete guild commands (if you registered them per-guild)
        const guilds = client.guilds.cache;
        for (const [guildId, guild] of guilds) {
            await guild.commands.set([]);
            console.log(`✅ Deleted slash commands in ${guild.name}`);
        }
        
        console.log('🎉 All slash commands removed!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
});

client.login(process.env.DISCORD_TOKEN);
