const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const PREFIX = '$';

// Database setup
const useDatabase = process.env.DATABASE_URL ? true : false;
let pool;

if (useDatabase) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    console.log('✅ Using PostgreSQL database');
} else {
    console.log('⚠️ No DATABASE_URL found, using in-memory storage');
}

// In-memory data (session data - never saved to DB)
const playerData = new Map();
const activeEncounter = { active: false, combatants: [], turnsTaken: new Set() };
const savedActions = new Map();

// Resource emojis
const RESOURCE_EMOJIS = {
    HP: '❤️',
    MP: '💧',
    IP: '💰',
    Armor: '💥',
    Barrier: '🛡️'
};

// Initialize player data
function initPlayer(userId, username, characterName = null) {
    if (!playerData.has(userId)) {
        playerData.set(userId, {
            username: username,
            characterName: characterName || username,
            HP: 100,
            MP: 50,
            IP: 0,
            Armor: 20,
            Barrier: 15,
            maxHP: 100,
            maxMP: 50,
            maxIP: 100,
            maxArmor: 20,
            maxBarrier: 15,
            statusEffects: []
        });
    }
}

// Load player from database (only when needed)
async function loadPlayerFromDB(userId) {
    if (!useDatabase) return null;
    
    try {
        const result = await pool.query('SELECT * FROM players WHERE user_id = $1', [userId]);
        if (result.rows.length > 0) {
            const row = result.rows[0];
            return {
                username: row.username,
                characterName: row.character_name,
                HP: row.max_hp, // Start at max
                MP: row.max_mp,
                IP: 0,
                Armor: row.max_armor,
                Barrier: row.max_barrier,
                maxHP: row.max_hp,
                maxMP: row.max_mp,
                maxIP: row.max_ip,
                maxArmor: row.max_armor,
                maxBarrier: row.max_barrier,
                statusEffects: []
            };
        }
    } catch (error) {
        console.error('Error loading player:', error);
    }
    return null;
}

// Save character sheet to database (ONLY on /set)
async function saveCharacterSheet(userId, data) {
    if (!useDatabase) return;
    
    try {
        await pool.query(`
            INSERT INTO players (
                user_id, username, character_name,
                hp, mp, ip, armor, barrier,
                max_hp, max_mp, max_ip, max_armor, max_barrier,
                status_effects, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) 
            DO UPDATE SET
                username = $2,
                character_name = $3,
                max_hp = $9,
                max_mp = $10,
                max_ip = $11,
                max_armor = $12,
                max_barrier = $13,
                updated_at = CURRENT_TIMESTAMP
        `, [
            userId,
            data.username,
            data.characterName,
            data.maxHP, // Initial values = max
            data.maxMP,
            data.maxIP,
            data.maxArmor,
            data.maxBarrier,
            data.maxHP,
            data.maxMP,
            data.maxIP,
            data.maxArmor,
            data.maxBarrier,
            JSON.stringify([])
        ]);
        console.log(`✅ Saved character sheet for ${data.characterName}`);
    } catch (error) {
        console.error('❌ Error saving character sheet:', error);
    }
}

// Command help data
const COMMANDS = {
    // Setup
    'view': {
        description: 'View your or another player\'s resources',
        usage: '$view [@player]',
        examples: ['$view', '$view @Gandalf']
    },
    
    // Combat - Fast
    'a': {
        description: 'Attack roll (alias: attack)',
        usage: '$a <d1> <d2> <mod> <gate>',
        examples: ['$a 10 8 5 1', '$a 12 6 10 2'],
        notes: 'Fumble (1,1) = Auto-Fail | Crit (same die ≥6) = Auto-Success'
    },
    'attack': {
        description: 'Attack roll (same as $a)',
        usage: '$attack <d1> <d2> <mod> <gate>',
        examples: ['$attack 10 8 5 1']
    },
    'c': {
        description: 'Cast spell (alias: cast)',
        usage: '$c <d1> <d2> <mod> <gate> [mp_cost]',
        examples: ['$c 10 8 15 1', '$c 10 8 15 1 20'],
        notes: 'Default MP cost: 10'
    },
    'cast': {
        description: 'Cast spell (same as $c)',
        usage: '$cast <d1> <d2> <mod> <gate> [mp_cost]',
        examples: ['$cast 10 8 15 1 20']
    },
    'hp': {
        description: 'Update HP',
        usage: '$hp <amount|full|zero>',
        examples: ['$hp -20', '$hp +15', '$hp full', '$hp zero']
    },
    'mp': {
        description: 'Update MP',
        usage: '$mp <amount|full|zero>',
        examples: ['$mp -10', '$mp full']
    },
    'armor': {
        description: 'Update Armor',
        usage: '$armor <amount|full|zero>',
        examples: ['$armor -15', '$armor full']
    },
    'barrier': {
        description: 'Update Barrier',
        usage: '$barrier <amount|full|zero>',
        examples: ['$barrier -10', '$barrier full']
    },
    'defend': {
        description: 'Add max Armor & Barrier to current values',
        usage: '$defend',
        examples: ['$defend']
    },
    'turn': {
        description: 'Clear Armor & Barrier to 0',
        usage: '$turn [@player]',
        examples: ['$turn', '$turn @Tank']
    },
    'rest': {
        description: 'Restore HP & MP to full',
        usage: '$rest',
        examples: ['$rest']
    },
    
    // GM Tools
    'gmattack': {
        description: 'GM attack with defend buttons',
        usage: '$gmattack <d1> <d2> <mod> <gate> <@targets> [armor|barrier|true]',
        examples: [
            '$gmattack 10 8 15 1 @Tank @DPS',
            '$gmattack 12 6 20 2 @Wizard barrier',
            '$gmattack 10 10 30 1 @All true'
        ],
        notes: 'Default damage type: armor. Players click buttons to defend or take damage.'
    },
    'damage': {
        description: 'Apply damage to players',
        usage: '$damage <amount> <armor|barrier> [@players]',
        examples: ['$damage 20 armor @Tank', '$damage 15 barrier @All']
    },
    
    // Clash Management
    'clash': {
        description: 'Manage combat encounters',
        usage: '$clash <start|end|add|remove|list>',
        examples: [
            '$clash start',
            '$clash add @Gandalf @Aragorn',
            '$clash remove @Orc',
            '$clash list',
            '$clash end'
        ]
    },
    'eot': {
        description: 'Mark end of turn',
        usage: '$eot [@player]',
        examples: ['$eot', '$eot @Gandalf']
    },
    'round': {
        description: 'Start new round (GM only)',
        usage: '$round',
        examples: ['$round'],
        notes: 'Resets turn tracker only. Does NOT refill armor/barrier.'
    },
    
    // Guide
    'guide': {
        description: 'Show command help',
        usage: '$guide [command]',
        examples: ['$guide', '$guide gmattack', '$guide attack']
    }
};

// Send guide
function sendGuide(message, commandName = null) {
    if (commandName) {
        // Specific command help
        const cmd = COMMANDS[commandName.toLowerCase()];
        if (!cmd) {
            message.reply(`Command \`${commandName}\` not found. Use \`$guide\` to see all commands.`);
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x00BFFF)
            .setTitle(`📖 ${commandName}`)
            .setDescription(cmd.description)
            .addFields({ name: 'Usage', value: `\`${cmd.usage}\``, inline: false });
        
        if (cmd.examples) {
            embed.addFields({ 
                name: 'Examples', 
                value: cmd.examples.map(ex => `\`${ex}\``).join('\n'), 
                inline: false 
            });
        }
        
        if (cmd.notes) {
            embed.addFields({ name: 'Notes', value: cmd.notes, inline: false });
        }
        
        message.reply({ embeds: [embed] });
        return;
    }
    
    // Full guide - list all commands
    const embed = new EmbedBuilder()
        .setColor(0x00BFFF)
        .setTitle('📖 Command Guide')
        .setDescription('Use `$guide <command>` for detailed help on a specific command.\n\n**Quick Commands:**')
        .addFields(
            {
                name: '⚔️ Combat (Fast)',
                value: '`$a` `$attack` `$c` `$cast` - Roll attacks/spells\n`$hp` `$mp` `$armor` `$barrier` - Update resources\n`$defend` `$turn` `$rest` - Quick actions',
                inline: false
            },
            {
                name: '🎲 GM Tools',
                value: '`$gmattack` `$damage` - GM attacks & damage\n`$round` - New round (GM only)',
                inline: false
            },
            {
                name: '⚔️ Clash',
                value: '`$clash` - Manage encounters\n`$eot` - End of turn',
                inline: false
            },
            {
                name: '📊 Info',
                value: '`$view` - View resources\n`$guide <cmd>` - Command help',
                inline: false
            }
        )
        .setFooter({ text: 'Example: $guide gmattack for detailed help' });
    
    message.reply({ embeds: [embed] });
}

client.on('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`✅ Prefix: ${PREFIX}`);
    console.log(`✅ Fast prefix commands enabled!`);
});

client.on('messageCreate', async message => {
    // Ignore bots and non-prefix messages
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;
    
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    
    try {
        // Guide
        if (command === 'guide') {
            sendGuide(message, args[0]);
            return;
        }
        
        // View
        if (command === 'view') {
            const targetUser = message.mentions.users.first() || message.author;
            const targetMember = await message.guild.members.fetch(targetUser.id);
            
            initPlayer(targetUser.id, targetMember.displayName);
            const data = playerData.get(targetUser.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${data.characterName}'s Resources`)
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();
            
            message.reply({ embeds: [embed] });
            return;
        }
        
        // Attack (fast!)
        if (command === 'a' || command === 'attack') {
            if (args.length < 4) {
                message.reply('Usage: `$a <d1> <d2> <mod> <gate>`\nExample: `$a 10 8 5 1`');
                return;
            }
            
            const dice1 = parseInt(args[0]);
            const dice2 = parseInt(args[1]);
            const modifier = parseInt(args[2]);
            const gate = parseInt(args[3]);
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            // Roll
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const highRoll = Math.max(roll1, roll2);
            const damage = highRoll + modifier;
            
            // Check result
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 >= 6;
            const isSuccess = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);
            
            // Build result
            let resultText = `**${data.characterName}** attacks!\n\n`;
            resultText += `🎲 d${dice1}: **${roll1}** | d${dice2}: **${roll2}**\n`;
            resultText += `Gate: ≤${gate}\n\n`;
            resultText += `HighRoll = **${highRoll}**\n`;
            resultText += `HR + ${modifier} = **${damage} damage**\n\n`;
            
            if (isFumble) {
                resultText += `💀 **FUMBLE!** (Auto-Miss)`;
            } else if (isCrit) {
                resultText += `⭐ **CRITICAL!** (Auto-Hit)`;
            } else if (isSuccess) {
                resultText += `✅ **HIT!** (Both dice > ${gate})`;
            } else {
                resultText += `❌ **MISS** (At least one die ≤ ${gate})`;
            }
            
            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isSuccess ? 0x00FF00 : 0xFF0000)
                .setDescription(resultText)
                .setTimestamp();
            
            message.reply({ embeds: [embed] });
            return;
        }
        
        // Cast (fast!)
        if (command === 'c' || command === 'cast') {
            if (args.length < 4) {
                message.reply('Usage: `$c <d1> <d2> <mod> <gate> [mp_cost]`\nExample: `$c 10 8 15 1 20`');
                return;
            }
            
            const dice1 = parseInt(args[0]);
            const dice2 = parseInt(args[1]);
            const modifier = parseInt(args[2]);
            const gate = parseInt(args[3]);
            const mpCost = args[4] ? parseInt(args[4]) : 10;
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            // Check MP
            if (data.MP < mpCost) {
                message.reply(`❌ Not enough MP! Need ${mpCost}, have ${data.MP}`);
                return;
            }
            
            // Spend MP
            data.MP -= mpCost;
            
            // Roll
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const highRoll = Math.max(roll1, roll2);
            const damage = highRoll + modifier;
            
            // Check result
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 >= 6;
            const isSuccess = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);
            
            // Build result
            let resultText = `**${data.characterName}** casts!\n\n`;
            resultText += `💧 MP: ${data.MP + mpCost} → ${data.MP} (-${mpCost})\n\n`;
            resultText += `🎲 d${dice1}: **${roll1}** | d${dice2}: **${roll2}**\n`;
            resultText += `Gate: ≤${gate}\n\n`;
            resultText += `HighRoll = **${highRoll}**\n`;
            resultText += `HR + ${modifier} = **${damage} damage**\n\n`;
            
            if (isFumble) {
                resultText += `💀 **FUMBLE!** (Auto-Miss)`;
            } else if (isCrit) {
                resultText += `⭐ **CRITICAL!** (Auto-Hit)`;
            } else if (isSuccess) {
                resultText += `✅ **HIT!** (Both dice > ${gate})`;
            } else {
                resultText += `❌ **MISS** (At least one die ≤ ${gate})`;
            }
            
            const embed = new EmbedBuilder()
                .setColor(isFumble ? 0x800000 : isCrit ? 0xFFD700 : isSuccess ? 0x00FF00 : 0xFF0000)
                .setDescription(resultText)
                .setTimestamp();
            
            message.reply({ embeds: [embed] });
            return;
        }
        
        // HP (fast!)
        if (command === 'hp') {
            if (args.length === 0) {
                message.reply('Usage: `$hp <amount|full|zero>`\nExample: `$hp -20` or `$hp full`');
                return;
            }
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const oldHP = data.HP;
            
            if (args[0] === 'full') {
                data.HP = data.maxHP;
            } else if (args[0] === 'zero') {
                data.HP = 0;
            } else {
                const amount = parseInt(args[0]);
                data.HP = Math.max(0, Math.min(data.maxHP, data.HP + amount));
            }
            
            message.reply(`❤️ **${data.characterName}** HP: ${oldHP} → ${data.HP}/${data.maxHP}`);
            return;
        }
        
        // MP (fast!)
        if (command === 'mp') {
            if (args.length === 0) {
                message.reply('Usage: `$mp <amount|full|zero>`');
                return;
            }
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const oldMP = data.MP;
            
            if (args[0] === 'full') {
                data.MP = data.maxMP;
            } else if (args[0] === 'zero') {
                data.MP = 0;
            } else {
                const amount = parseInt(args[0]);
                data.MP = Math.max(0, Math.min(data.maxMP, data.MP + amount));
            }
            
            message.reply(`💧 **${data.characterName}** MP: ${oldMP} → ${data.MP}/${data.maxMP}`);
            return;
        }
        
        // Armor (fast!)
        if (command === 'armor') {
            if (args.length === 0) {
                message.reply('Usage: `$armor <amount|full|zero>`');
                return;
            }
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const oldArmor = data.Armor;
            
            if (args[0] === 'full') {
                data.Armor = data.maxArmor;
            } else if (args[0] === 'zero') {
                data.Armor = 0;
            } else {
                const amount = parseInt(args[0]);
                data.Armor = Math.max(0, data.Armor + amount);
            }
            
            message.reply(`💥 **${data.characterName}** Armor: ${oldArmor} → ${data.Armor}/${data.maxArmor}`);
            return;
        }
        
        // Barrier (fast!)
        if (command === 'barrier') {
            if (args.length === 0) {
                message.reply('Usage: `$barrier <amount|full|zero>`');
                return;
            }
            
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const oldBarrier = data.Barrier;
            
            if (args[0] === 'full') {
                data.Barrier = data.maxBarrier;
            } else if (args[0] === 'zero') {
                data.Barrier = 0;
            } else {
                const amount = parseInt(args[0]);
                data.Barrier = Math.max(0, data.Barrier + amount);
            }
            
            message.reply(`🛡️ **${data.characterName}** Barrier: ${oldBarrier} → ${data.Barrier}/${data.maxBarrier}`);
            return;
        }
        
        // Defend (fast!)
        if (command === 'defend') {
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            const oldArmor = data.Armor;
            const oldBarrier = data.Barrier;
            
            data.Armor += data.maxArmor;
            data.Barrier += data.maxBarrier;
            
            message.reply(`🛡️ **${data.characterName}** defended!\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${data.Armor}\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${data.Barrier}`);
            return;
        }
        
        // Turn (fast!)
        if (command === 'turn') {
            const targetUser = message.mentions.users.first() || message.author;
            const targetMember = await message.guild.members.fetch(targetUser.id);
            
            initPlayer(targetUser.id, targetMember.displayName);
            const data = playerData.get(targetUser.id);
            
            data.Armor = 0;
            data.Barrier = 0;
            
            message.reply(`💨 **${data.characterName}** turn reset!\n💥 Armor: 0\n🛡️ Barrier: 0`);
            return;
        }
        
        // Rest (fast!)
        if (command === 'rest') {
            const userId = message.author.id;
            initPlayer(userId, message.member.displayName);
            const data = playerData.get(userId);
            
            data.HP = data.maxHP;
            data.MP = data.maxMP;
            
            message.reply(`✨ **${data.characterName}** rested!\n❤️ HP: ${data.HP}/${data.maxHP}\n💧 MP: ${data.MP}/${data.maxMP}`);
            return;
        }
        
        // GM Attack
        if (command === 'gmattack') {
            if (args.length < 5) {
                message.reply('Usage: `$gmattack <d1> <d2> <mod> <gate> <@targets> [armor|barrier|true]`\nExample: `$gmattack 10 8 15 1 @Tank @DPS`');
                return;
            }
            
            const dice1 = parseInt(args[0]);
            const dice2 = parseInt(args[1]);
            const modifier = parseInt(args[2]);
            const gate = parseInt(args[3]);
            
            // Find damage type (last arg if it's armor/barrier/true)
            let damageType = 'armor';
            const lastArg = args[args.length - 1].toLowerCase();
            if (lastArg === 'armor' || lastArg === 'barrier' || lastArg === 'true') {
                damageType = lastArg;
                args.pop(); // Remove from args
            }
            
            // Get targets from mentions
            const targetMatches = message.content.match(/<@!?(\d+)>/g) || [];
            const targetIds = targetMatches.map(match => match.match(/\d+/)[0]);
            
            if (targetIds.length === 0) {
                message.reply('❌ No valid targets found. Mention players with @player');
                return;
            }
            
            // Roll
            const roll1 = Math.floor(Math.random() * dice1) + 1;
            const roll2 = Math.floor(Math.random() * dice2) + 1;
            const highRoll = Math.max(roll1, roll2);
            const damage = highRoll + modifier;
            
            // Check result
            const isFumble = roll1 === 1 && roll2 === 1;
            const isCrit = !isFumble && roll1 === roll2 && roll1 >= 6;
            const isHit = isFumble ? false : isCrit ? true : (roll1 > gate && roll2 > gate);
            
            // Build result
            let resultText = `> **GM Attack** ⚔️\n`;
            resultText += `> \n`;
            resultText += `> d${dice1}: **${roll1}** | d${dice2}: **${roll2}**\n`;
            resultText += `> Gate: ≤${gate}\n`;
            resultText += `> \n`;
            resultText += `> HighRoll = **${highRoll}**\n`;
            resultText += `> HR + ${modifier} = **${damage} damage**\n`;
            resultText += `> \n`;
            
            if (isFumble) {
                resultText += `> 💀 **FUMBLE!** (Auto-Miss)`;
                
                const embed = new EmbedBuilder()
                    .setColor(0x800000)
                    .setTitle('🎲 GM Attack')
                    .setDescription(resultText)
                    .setTimestamp();
                
                message.reply({ embeds: [embed] });
                return;
            } else if (!isHit) {
                resultText += `> ❌ **MISS**`;
                
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle('🎲 GM Attack')
                    .setDescription(resultText)
                    .setTimestamp();
                
                message.reply({ embeds: [embed] });
                return;
            }
            
            // Hit!
            if (isCrit) {
                resultText += `> ⭐ **CRITICAL!** (Auto-Hit)`;
            } else {
                resultText += `> ✅ **HIT!**`;
            }
            
            const embed = new EmbedBuilder()
                .setColor(isCrit ? 0xFFD700 : 0x00FF00)
                .setTitle('🎲 GM Attack - HIT!')
                .setDescription(resultText)
                .addFields({
                    name: 'Targets',
                    value: targetMatches.join(' '),
                    inline: false
                })
                .setFooter({ text: `${damage} ${damageType} damage incoming!` })
                .setTimestamp();
            
            // Buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`gmattack_defend_${damage}_${damageType}_${message.id}`)
                        .setLabel('🛡️ React with Defend')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`gmattack_take_${damage}_${damageType}_${message.id}`)
                        .setLabel('💔 Take Damage')
                        .setStyle(ButtonStyle.Danger)
                );
            
            message.reply({
                content: `${targetMatches.join(' ')} ⚔️ **INCOMING ATTACK!**`,
                embeds: [embed],
                components: [row]
            });
            return;
        }
        
        // Clash management
        if (command === 'clash') {
            const subcommand = args[0]?.toLowerCase();
            
            if (!subcommand) {
                message.reply('Usage: `$clash <start|end|add|remove|list>`');
                return;
            }
            
            if (subcommand === 'start') {
                activeEncounter.active = true;
                activeEncounter.combatants = [];
                activeEncounter.turnsTaken.clear();
                message.reply('⚔️ **Clash started!** Add combatants with `$clash add @player`');
                return;
            }
            
            if (subcommand === 'end') {
                activeEncounter.active = false;
                activeEncounter.combatants = [];
                activeEncounter.turnsTaken.clear();
                message.reply('✅ **Clash ended!**');
                return;
            }
            
            if (subcommand === 'add') {
                if (!activeEncounter.active) {
                    message.reply('❌ No active clash. Use `$clash start` first.');
                    return;
                }
                
                const mentioned = message.mentions.users;
                if (mentioned.size === 0) {
                    message.reply('❌ Mention players to add: `$clash add @player1 @player2`');
                    return;
                }
                
                let added = 0;
                for (const [userId, user] of mentioned) {
                    if (!activeEncounter.combatants.includes(userId)) {
                        // Load from database if exists
                        const dbData = await loadPlayerFromDB(userId);
                        if (dbData) {
                            playerData.set(userId, dbData);
                        } else {
                            const member = await message.guild.members.fetch(userId);
                            initPlayer(userId, member.displayName);
                        }
                        
                        activeEncounter.combatants.push(userId);
                        added++;
                    }
                }
                
                message.reply(`✅ Added ${added} combatant(s) to clash!`);
                return;
            }
            
            if (subcommand === 'remove') {
                const mentioned = message.mentions.users;
                if (mentioned.size === 0) {
                    message.reply('❌ Mention players to remove: `$clash remove @player`');
                    return;
                }
                
                let removed = 0;
                for (const [userId] of mentioned) {
                    const index = activeEncounter.combatants.indexOf(userId);
                    if (index > -1) {
                        activeEncounter.combatants.splice(index, 1);
                        removed++;
                    }
                }
                
                message.reply(`✅ Removed ${removed} combatant(s) from clash!`);
                return;
            }
            
            if (subcommand === 'list') {
                if (!activeEncounter.active) {
                    message.reply('❌ No active clash.');
                    return;
                }
                
                if (activeEncounter.combatants.length === 0) {
                    message.reply('⚔️ Clash active but no combatants yet.');
                    return;
                }
                
                let list = '**Clash Combatants:**\n\n';
                for (const userId of activeEncounter.combatants) {
                    const data = playerData.get(userId);
                    if (data) {
                        const turnIcon = activeEncounter.turnsTaken.has(userId) ? '✅' : '⬜';
                        list += `${turnIcon} **${data.characterName}**\n`;
                        list += `❤️ ${data.HP}/${data.maxHP} | 💧 ${data.MP}/${data.maxMP} | 💥 ${data.Armor}/${data.maxArmor} | 🛡️ ${data.Barrier}/${data.maxBarrier}\n\n`;
                    }
                }
                
                message.reply(list);
                return;
            }
        }
        
        // End of turn
        if (command === 'eot') {
            if (!activeEncounter.active) {
                message.reply('❌ No active clash.');
                return;
            }
            
            const targetUser = message.mentions.users.first() || message.author;
            activeEncounter.turnsTaken.add(targetUser.id);
            
            const data = playerData.get(targetUser.id);
            const name = data ? data.characterName : targetUser.username;
            
            message.reply(`✅ **${name}** ended their turn!`);
            return;
        }
        
        // Round
        if (command === 'round') {
            if (!activeEncounter.active) {
                message.reply('❌ No active clash.');
                return;
            }
            
            activeEncounter.turnsTaken.clear();
            
            const mentions = activeEncounter.combatants.map(id => `<@${id}>`).join(' ');
            
            message.reply(`🔄 **New Round Started!**\n✅ Turn tracker reset\n\n${mentions}`);
            return;
        }
        
    } catch (error) {
        console.error('Command error:', error);
        message.reply('❌ An error occurred processing that command.');
    }
});

// Button interactions (gmattack defend/take)
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    
    const parts = interaction.customId.split('_');
    const action = parts[0];
    
    if (action === 'gmattack') {
        try {
            const [, buttonType, damageStr, damageType] = parts;
            const damage = parseInt(damageStr);
            
            const userId = interaction.user.id;
            const playerMember = interaction.member;
            
            initPlayer(userId, playerMember.displayName);
            const data = playerData.get(userId);
            
            const oldArmor = data.Armor;
            const oldBarrier = data.Barrier;
            const oldHP = data.HP;
            let resultText = '';
            
            if (buttonType === 'defend') {
                // DEFEND: Add BOTH max
                data.Armor += data.maxArmor;
                data.Barrier += data.maxBarrier;
                
                // Apply damage
                if (damageType === 'armor') {
                    const armorDamage = Math.min(damage, data.Armor);
                    const overflow = Math.max(0, damage - data.Armor);
                    data.Armor = Math.max(0, data.Armor - damage);
                    
                    if (overflow > 0) {
                        data.HP = Math.max(0, data.HP - overflow);
                        resultText = `**${data.characterName}** DEFENDED!\n\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${oldArmor + data.maxArmor} → ${data.Armor}\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${data.Barrier} (untouched)\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                    } else {
                        resultText = `**${data.characterName}** DEFENDED!\n\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${oldArmor + data.maxArmor} → ${data.Armor}\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${data.Barrier} (untouched)`;
                    }
                } else if (damageType === 'barrier') {
                    const barrierDamage = Math.min(damage, data.Barrier);
                    const overflow = Math.max(0, damage - data.Barrier);
                    data.Barrier = Math.max(0, data.Barrier - damage);
                    
                    if (overflow > 0) {
                        data.HP = Math.max(0, data.HP - overflow);
                        resultText = `**${data.characterName}** DEFENDED!\n\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${data.Armor} (untouched)\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${oldBarrier + data.maxBarrier} → ${data.Barrier}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                    } else {
                        resultText = `**${data.characterName}** DEFENDED!\n\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${data.Armor} (untouched)\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${oldBarrier + data.maxBarrier} → ${data.Barrier}`;
                    }
                } else if (damageType === 'true') {
                    data.HP = Math.max(0, data.HP - damage);
                    resultText = `**${data.characterName}** DEFENDED!\n\n💥 Armor: ${oldArmor} +${data.maxArmor} = ${data.Armor}\n🛡️ Barrier: ${oldBarrier} +${data.maxBarrier} = ${data.Barrier}\n💔 True Damage: ${damage} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                }
            } else if (buttonType === 'take') {
                // TAKE DAMAGE
                if (damageType === 'armor') {
                    const armorDamage = Math.min(damage, data.Armor);
                    const overflow = Math.max(0, damage - data.Armor);
                    data.Armor = Math.max(0, data.Armor - damage);
                    
                    if (overflow > 0) {
                        data.HP = Math.max(0, data.HP - overflow);
                        resultText = `**${data.characterName}** took the hit!\n\n💥 Armor: ${oldArmor} → ${data.Armor}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                    } else {
                        resultText = `**${data.characterName}** took the hit!\n\n💥 Armor: ${oldArmor} → ${data.Armor}`;
                    }
                } else if (damageType === 'barrier') {
                    const barrierDamage = Math.min(damage, data.Barrier);
                    const overflow = Math.max(0, damage - data.Barrier);
                    data.Barrier = Math.max(0, data.Barrier - damage);
                    
                    if (overflow > 0) {
                        data.HP = Math.max(0, data.HP - overflow);
                        resultText = `**${data.characterName}** took the hit!\n\n🛡️ Barrier: ${oldBarrier} → ${data.Barrier}\n💔 Overflow: ${overflow} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                    } else {
                        resultText = `**${data.characterName}** took the hit!\n\n🛡️ Barrier: ${oldBarrier} → ${data.Barrier}`;
                    }
                } else if (damageType === 'true') {
                    data.HP = Math.max(0, data.HP - damage);
                    resultText = `**${data.characterName}** took the hit!\n\n💔 True Damage: ${damage} → HP: ${oldHP} → ${data.HP}/${data.maxHP}`;
                }
            }
            
            await interaction.reply({ content: resultText });
            
        } catch (error) {
            console.error('Button error:', error);
            await interaction.reply({ content: '❌ Error processing button.', ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
