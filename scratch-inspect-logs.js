const fs = require('fs');
const path = require('path');

const logPath = 'C:\\ProgramData\\SEVATN\\Worker\\logs\\worker.log';
if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n');
  console.log('=== WORKER LOG TAIL (Last 50 lines) ===');
  console.log(lines.slice(-50).join('\n'));
} else {
  console.log('Worker log not found at', logPath);
}

const configPath = 'C:\\ProgramData\\SEVATN\\Worker\\config.json';
if (fs.existsSync(configPath)) {
  console.log('=== WORKER CONFIG ===');
  console.log(fs.readFileSync(configPath, 'utf8'));
}

const identityPath = 'C:\\ProgramData\\SEVATN\\Worker\\machine-identity.json';
if (fs.existsSync(identityPath)) {
  console.log('=== MACHINE IDENTITY ===');
  console.log(fs.readFileSync(identityPath, 'utf8'));
}
