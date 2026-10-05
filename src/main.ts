import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { startObservers } from './perf/metrics'
import { ChunkScheduler } from './perf/scheduler'
import { memoizeLru } from './perf/lruMemo'

startObservers()
createApp(App).mount('#app')

// 供面板/控制台做单元级验证(可观测性的一部分, 非业务路径)
;(window as unknown as { __perf: unknown }).__perf = { ChunkScheduler, memoizeLru }
