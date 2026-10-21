#!/usr/bin/env node
// 아주 작은 메모 프로그램. 메모는 메모리에만 있어서 끄면 사라진다.
import readline from 'node:readline';

const memos = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('메모를 입력하세요. "목록" 은 전체 보기, "끝" 은 종료.');
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '끝') return rl.close();
  if (text === '목록') {
    memos.forEach((memo, i) => console.log(`${i + 1}. ${memo}`));
    return;
  }
  if (text !== '') memos.push(text);
});
