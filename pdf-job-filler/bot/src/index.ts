import { config, checkConfig } from './config.ts';
import { createBot } from './bot.ts';

const problems = checkConfig();
if (problems.length) {
  console.error('Cannot start the bot:\n - ' + problems.join('\n - ') + '\nCopy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = createBot();

await bot.telegram.setMyCommands([
  { command: 'write', description: 'Fill the form: /write <Job Name> + source PDF' },
  { command: 'template', description: 'Show the active template' },
  { command: 'help', description: 'How to use the bot' },
  { command: 'start', description: 'Start' },
]).catch((e) => console.warn('setMyCommands failed:', e.message));

bot
  .launch(() => {
    console.log(`PDF Job Filler bot running. Allowed user(s): ${config.allowedUserIds.join(', ')}`);
    console.log(`Template: ${config.templatePath}`);
  })
  .catch((e) => {
    const msg = String(e?.message ?? e);
    if (/401|Unauthorized/i.test(msg)) console.error('Telegram refused the BOT_TOKEN. Copy it again from @BotFather into .env.');
    else if (/409|Conflict/i.test(msg)) console.error('The bot is already running somewhere else (another window/PC). Stop the other one.');
    else console.error('Could not connect to Telegram:', msg);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
