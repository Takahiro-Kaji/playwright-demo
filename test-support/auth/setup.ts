import { chromium } from '@playwright/test';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve, sep, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export function validateAuthConfig(state:string,target:string) {
  const root=resolve('.local/auth')+sep;const path=resolve(state);
  if(!path.startsWith(root)||!path.endsWith('.json')) throw Error('AUTH_PATH_REQUIRED');
  const url=new URL(target); if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw Error('HTTPS_TARGET_REQUIRED');
  return {path,url:url.toString()};
}
export async function setupAuth(state:string,target:string) {
  const {path,url}=validateAuthConfig(state,target);await mkdir(dirname(path),{recursive:true,mode:0o700});
  const terminal=createInterface({input:stdin,output:stdout});let browser=await chromium.launch({channel:'chrome',headless:false});
  try {
    const context=await browser.newContext();const page=await context.newPage();await page.goto(url);
    await terminal.question('ブラウザーで手動ログインし、完了後にEnterを押してください。');
    await context.storageState({path});await chmod(path,0o600);await context.close();
    const check=await browser.newContext({storageState:path});const p=await check.newPage();await p.goto(url);
    await terminal.question('新しいコンテキストで認証済み画面を確認し、Enterを押してください。');await check.close();await browser.close();
    browser=await chromium.launch({channel:'chrome',headless:false});const restarted=await browser.newContext({storageState:path});const again=await restarted.newPage();await again.goto(url);
    await terminal.question('Chrome再起動後の認証済み画面を確認し、Enterを押してください。');await restarted.close();
    console.log('手動確認入口を終了しました。認証成功はユーザー確認待ちです。');
  } finally {terminal.close();await browser.close();}
}
if(import.meta.main) {if(!process.stdin.isTTY) throw Error('INTERACTIVE_TERMINAL_REQUIRED');try {await setupAuth(process.env.SALES_AUTH_STATE!,process.env.SALES_AUTH_URL!);} catch {console.error('認証準備を完了できませんでした。');process.exitCode=1;}}
