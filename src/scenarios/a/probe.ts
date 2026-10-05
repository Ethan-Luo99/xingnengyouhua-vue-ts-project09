import { reactive } from 'vue'

/** 场景 A 卸载后残留探针结果（供面板读取） */
export const aProbe = reactive({
  ran: false,
  listenerFires: -1,
  watcherFires: -1,
  intervalTicks: -1,
})
