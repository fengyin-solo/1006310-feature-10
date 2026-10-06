<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标；排水口径与廊内排水运维页同源，确认正常后待排水泵坑数同步回落。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <h3 class="section-title">廊内排水运维</h3>
    <div class="stat-row">
      <article v-for="card in drainageCards" :key="card.label" class="stat-card" :class="{ alert: card.alert }">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <p class="status-legend">
      <span class="legend-item">对账结论：{{ drainage.report.message }}</span>
      <span class="legend-item" :class="{ 'error-text': !drainage.report.ledgerMatched }">
        {{ drainage.report.ledgerMatched ? '待办全部挂在真实值班台账上，条数与台账对得上' : '存在未挂台账的待办，需补挂' }}
      </span>
    </p>

    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section class="todo-panel">
      <h3>值班台账待办对账（共 {{ drainage.todos.length }} 条）</h3>
      <table class="data-table">
        <thead>
          <tr><th>交接编号</th><th>班次</th><th>挂接待办数</th></tr>
        </thead>
        <tbody>
          <tr v-for="group in drainage.report.todoCountByLedger" :key="group.交接编号">
            <td>{{ group.交接编号 }}</td>
            <td>{{ group.班次 }}</td>
            <td>{{ group.待办数 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里（urban-utility-tunnel:state:v2），覆盖落库、历史只追加；换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadDrainage, loadOverview } from '@/api/local-service'
import type { DrainageView, OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const drainage = ref<DrainageView>(loadDrainage())

const drainageCards = computed(() => [
  { label: '待排水泵坑（含排水中）', value: drainage.value.stats['待排水泵坑'] ?? 0, alert: false },
  { label: '排水中泵坑', value: drainage.value.stats['排水中泵坑'] ?? 0, alert: true },
  { label: '水位正常泵坑', value: drainage.value.stats['水位正常泵坑'] ?? 0, alert: false },
  { label: '水泵故障数', value: drainage.value.stats['水泵故障数'] ?? 0, alert: true },
  { label: '启泵水位待核定', value: drainage.value.stats['待核定启泵水位'] ?? 0, alert: true },
])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  drainage.value = loadDrainage()
}

onMounted(refresh)
</script>
