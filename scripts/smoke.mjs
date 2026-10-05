// 零依赖 CDP 冒烟测试(验收复跑):
//   1. npm run build && npx vite preview --port 5199
//   2. CHROME=/path/to/chrome node scripts/smoke.mjs
// 需要本机有 Chrome/Chromium; 仅用 Node 内置模块, 不引入 npm 依赖
import { spawn } from 'node:child_process'

const CHROME = process.env.CHROME
const BASE = process.env.BASE_URL || 'http://localhost:5199'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--remote-debugging-port=9223',
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())

async function getWsUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9223/json')
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('chrome not ready')
}

const ws = new WebSocket(await getWsUrl())
await new Promise((r) => (ws.onopen = r))
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaljs(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text))
  return r.result.value
}
async function waitFor(expr, timeout = 30000, label = expr) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await evaljs(expr)) return
    } catch {}
    await sleep(300)
  }
  throw new Error('超时等待: ' + label)
}
function clickByText(selector, text) {
  return `(function(){ const els=[...document.querySelectorAll(${JSON.stringify(selector)})];
    const el=els.find(e=>e.textContent.includes(${JSON.stringify(text)}));
    if(!el) throw new Error('找不到元素 '+${JSON.stringify(text)}); el.click(); return true })()`
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: BASE })
await waitFor(`document.body.innerText.includes('场景 A')`, 15000, '首页渲染')
console.log('✓ 页面加载')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? '✓' : '✗'} ${name} ${detail}`)
}

// ---------- 场景 A ----------
await evaljs(clickByText('.bench-head button', '复跑对比'))
await waitFor(`!document.querySelector('.bench-head button').disabled`, 30000, 'A 对比完成')
const aRows = await evaljs(`(function(){
  const bench=[...document.querySelectorAll('.bench')][0];
  return [...bench.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()))
})()`)
const aMap = Object.fromEntries(aRows.map((r) => [r[0], { base: r[1], opt: r[2] }]))
console.log('A 表:', JSON.stringify(aMap))
check('A 基线有长任务', parseInt(aMap['首屏长任务数(>50ms)']?.base) >= 1, aMap['首屏长任务数(>50ms)']?.base)
check('A 优化后长任务为0', aMap['首屏长任务数(>50ms)']?.opt === '0', aMap['首屏长任务数(>50ms)']?.opt)
check('A 基线卸载有残留', parseInt(aMap['卸载后残留副作用']?.base) > 0, aMap['卸载后残留副作用']?.base)
check('A 优化后零残留', aMap['卸载后残留副作用']?.opt === '0', aMap['卸载后残留副作用']?.opt)
check('A 基线定时器泄漏', aMap['卸载后定时器仍跳动']?.base?.includes('是'), aMap['卸载后定时器仍跳动']?.base)
check('A 优化后无泄漏', aMap['卸载后定时器仍跳动']?.opt === '否', aMap['卸载后定时器仍跳动']?.opt)

// ---------- 场景 B ----------
await evaljs(clickByText('nav button', '场景B'))
await waitFor(`document.body.innerText.includes('触发扇出')`, 5000, 'B 页渲染')
await evaljs(clickByText('button', '触发扇出'))
await sleep(500)
const bBenchBtns = `(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景B'));
  b.querySelector('button').click(); return true })()`
await evaljs(bBenchBtns)
await waitFor(`(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景B'));
  return !b.querySelector('button').disabled })()`, 30000, 'B 对比完成')
const bRows = await evaljs(`(function(){
  const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景B'));
  return [...b.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()))
})()`)
const bMap = Object.fromEntries(bRows.map((r) => [r[0], { base: r[1], opt: r[2] }]))
console.log('B 表:', JSON.stringify(bMap))
check('B 基线 watcher 连锁放大', parseInt(bMap['watcher 触发次数']?.base) > 500, bMap['watcher 触发次数']?.base)
check('B 优化 watcher 去重(=30)', bMap['watcher 触发次数']?.opt === '30', bMap['watcher 触发次数']?.opt)
check('B 基线派生重复计算(=60)', bMap['派生计算次数']?.base === '60', bMap['派生计算次数']?.base)
check('B 优化派生合并(=1)', bMap['派生计算次数']?.opt === '1', bMap['派生计算次数']?.opt)
check('B 优化渲染数少于基线', parseInt(bMap['渲染组件数']?.opt) < parseInt(bMap['渲染组件数']?.base),
  `${bMap['渲染组件数']?.base} -> ${bMap['渲染组件数']?.opt}`)
check('B 记忆化有命中', parseInt(bMap['记忆化命中']?.opt) > 100, bMap['记忆化命中']?.opt)
check('B 基线强制布局>优化', parseInt(bMap['强制布局次数']?.base) > parseInt(bMap['强制布局次数']?.opt),
  `${bMap['强制布局次数']?.base} -> ${bMap['强制布局次数']?.opt}`)

// ---------- 场景 C ----------
await evaljs(clickByText('nav button', '场景C'))
await waitFor(`document.body.innerText.includes('三源')`, 5000, 'C 页渲染')
await evaljs(clickByText('button', '运行 C1 边界用例'))
await waitFor(`document.body.innerText.includes('用例3')`, 15000, 'C 边界用例')
const edgePass = await evaljs(`[...document.querySelectorAll('.edge p')].every(p=>p.textContent.startsWith('✓'))`)
const edgeText = await evaljs(`[...document.querySelectorAll('.edge p')].map(p=>p.textContent).join(' | ')`)
check('C 边界用例全部通过', edgePass, edgeText)
const cBench = `(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景C'));
  b.querySelector('button').click(); return true })()`
await evaljs(cBench)
await waitFor(`(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景C'));
  return !b.querySelector('button').disabled })()`, 60000, 'C 对比完成')
const cRows = await evaljs(`(function(){
  const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('场景C'));
  return [...b.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()))
})()`)
const cMap = Object.fromEntries(cRows.map((r) => [r[0], { base: r[1], opt: r[2] }]))
console.log('C 表:', JSON.stringify(cMap))
check('C 优化丢帧率显著低于基线', parseFloat(cMap['丢帧率%']?.opt) < parseFloat(cMap['丢帧率%']?.base),
  `${cMap['丢帧率%']?.base}% -> ${cMap['丢帧率%']?.opt}%`)
check('C 优化渲染次数远少于基线', parseInt(cMap['列表渲染次数']?.opt) < parseInt(cMap['列表渲染次数']?.base) / 3,
  `${cMap['列表渲染次数']?.base} -> ${cMap['列表渲染次数']?.opt}`)
check('C 优化帧JS P95 ≤ 8ms', parseFloat(cMap['帧JS P95(ms)']?.opt) <= 8, cMap['帧JS P95(ms)']?.opt)

// ---------- C3: watcher pause/resume ----------
await evaljs(`[...document.querySelectorAll('.flag')].find(l=>l.textContent.includes('pause')).querySelector('input').click(); true`)
await evaljs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('启动三源')).click(); true`)
await sleep(1500)
const counterVal = `(function(){ const rows=[...document.querySelectorAll('.counters tr')];
  const r=rows.find(x=>x.children[0]?.textContent==='C 离屏 watcher 触发');
  return r ? parseInt(r.children[1].textContent) : -1 })()`
const beforeHide = await evaljs(counterVal)
// 隐藏离屏面板 -> 应暂停
await evaljs(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('离屏统计面板可见')).querySelector('input').click(); true`)
await sleep(800)
const hidden1 = await evaljs(counterVal)
await sleep(700)
const hidden2 = await evaljs(counterVal)
check('C3 隐藏时 watcher 暂停(计数停涨)', hidden1 === hidden2 && hidden1 > 0, `${beforeHide} -> ${hidden1} -> ${hidden2}`)
// 恢复显示 -> 恢复且一致
await evaljs(`[...document.querySelectorAll('label')].find(l=>l.textContent.includes('离屏统计面板可见')).querySelector('input').click(); true`)
await sleep(1200)
const resumed = await evaljs(counterVal)
const consistent = await evaljs(`document.querySelector('.panel b')?.textContent ?? ''`)
check('C3 恢复后 watcher 继续且依赖不丢', resumed > hidden2 && consistent.includes('✓'), `resumed=${resumed} 一致性=${consistent}`)
await evaljs(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('停止')).click(); true`)
await evaljs(`[...document.querySelectorAll('.btnrow button')].find(b=>b.textContent==='全关(基线)').click(); true`)

// ---------- 调度器单元验证: 取消/错误传播/重入 ----------
const schedOut = await evaljs(`(async () => {
  const { ChunkScheduler } = window.__perf
  const s = new ChunkScheduler({ budgetMs: 8 })
  const out = []
  const p1 = s.enqueue(() => { throw new Error('boom') }).then(()=>out.push('p1-ok'), e=>out.push('p1-err'))
  const p2 = s.enqueue(() => 42).then(v=>out.push('p2-'+v))
  const ac = new AbortController()
  const p3 = s.enqueue(() => out.push('p3-ran'), { signal: ac.signal }).catch(()=>out.push('p3-cancelled'))
  ac.abort()
  const p4 = s.enqueue(() => { s.enqueue(()=>out.push('nested')).catch(()=>{}); out.push('outer') })
  await Promise.allSettled([p1,p2,p3,p4])
  await s.whenIdle()
  return out.sort().join('|')
})()`)
check('调度器 取消/错误传播/重入', schedOut.includes('p1-err') && schedOut.includes('p2-42') && schedOut.includes('p3-cancelled') && !schedOut.includes('p3-ran') && schedOut.includes('outer') && schedOut.includes('nested'), schedOut)

// ---------- LRU 记忆化单元验证: 对象键/容量淘汰/版本失效 ----------
const memoOut = await evaljs(`(async () => {
  const { memoizeLru } = window.__perf
  let calls = 0, ver = 1
  const m = memoizeLru((o, k) => { calls++; return o.x + k }, { max: 2, version: () => ver })
  const a = { x: 1 }, b = { x: 2 }, c = { x: 3 }
  m(a, 1); m(a, 1)
  m(b, 1); m(c, 1)
  m(a, 1)
  ver = 2; m(b, 1)
  return JSON.stringify({ calls, hits: m.stats.hits, evictions: m.stats.evictions, invalidations: m.stats.invalidations })
})()`)
const memoObj = JSON.parse(memoOut)
check('LRU 对象键/淘汰/版本失效', memoObj.calls === 5 && memoObj.hits === 1 && memoObj.evictions === 2 && memoObj.invalidations === 1, memoOut)

// ---------- 表格 T ----------
await evaljs(clickByText('nav button', '表格'))
await waitFor(`document.body.innerText.includes('随机部分更新')`, 5000, 'T 页渲染')
const tBench = `(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('v-memo'));
  b.querySelector('button').click(); return true })()`
await evaljs(tBench)
await waitFor(`(function(){ const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('v-memo'));
  return !b.querySelector('button').disabled })()`, 30000, 'T 对比完成')
const tRows = await evaljs(`(function(){
  const bs=[...document.querySelectorAll('.bench')];
  const b=bs.find(x=>x.querySelector('.bench-head').textContent.includes('v-memo'));
  return [...b.querySelectorAll('tbody tr')].map(tr=>[...tr.children].map(td=>td.textContent.trim()))
})()`)
const tMap = Object.fromEntries(tRows.map((r) => [r[0], { base: r[1], opt: r[2] }]))
console.log('T 表:', JSON.stringify(tMap))
check('T 基线 stale=0', tMap['stale行数']?.base === '0', tMap['stale行数']?.base)
check('T 优化 stale=0', tMap['stale行数']?.opt === '0', tMap['stale行数']?.opt)
check('T 优化渲染次数远少于基线', parseInt(tMap['单元渲染次数']?.opt) < parseInt(tMap['单元渲染次数']?.base) / 3,
  `${tMap['单元渲染次数']?.base} -> ${tMap['单元渲染次数']?.opt}`)

const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} 通过 ====`)
chrome.kill()
process.exit(failed.length ? 1 : 0)
