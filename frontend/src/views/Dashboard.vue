<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。排水泵坑确认正常后，待排水泵坑数随之回落。</p>
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

    <h3 class="block-title">廊内排水运维口径</h3>
    <div class="stat-row">
      <article v-for="card in drainageCards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value" :class="{ alarm: card.label === '待排水泵坑' && card.value > 0 }">{{ card.value }}</strong>
      </article>
    </div>
    <p class="hint">待排水口径 = 待排水 + 排水中；确认水位正常回落一次，重复确认不重复回落，水泵故障不计入。</p>

    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
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
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，台账、待办、历史一次落库；换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const drainageCards = ref<OverviewResult['drainage']>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  drainageCards.value = payload.drainage
}

onMounted(refresh)
</script>

<style scoped>
.block-title { margin: 18px 0 10px; font-size: 15px; }
.hint { color: var(--muted); font-size: 12px; margin: 0 0 14px; }
.alarm { color: #b42318; }
</style>
