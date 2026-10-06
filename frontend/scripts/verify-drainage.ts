/**
 * 廊内排水运维取值口径验证：不依赖浏览器，用内存 localStorage 直接跑数据层。
 * 运行：npm run verify:drainage
 */
import { setStorageDriver, reloadCache, storageKey } from '@/data/local-store'
import {
  loadDrainage,
  registerDrainagePit,
  runDrainageAction,
  runDrainageReconcile,
  saveDrainagePit,
  confirmDutyHandover,
} from '@/api/local-service'

type Store = Map<string, string>

function memoryDriver(failures: { setFailUntil?: number } = {}) {
  const store: Store = new Map()
  let setAttempts = 0
  return {
    store,
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      setAttempts += 1
      if (failures.setFailUntil && setAttempts <= failures.setFailUntil) {
        throw new Error('模拟断线：localStorage 暂不可写')
      }
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const actor = { operator: '测试值班员', shift: '白班 08:00-20:00' }

function freshDriver() {
  const drv = memoryDriver()
  setStorageDriver(drv)
  return drv
}

function byCode(code: string) {
  const pit = loadDrainage().pits.find((item) => item.泵坑编号 === code)
  if (!pit) throw new Error(`缺少泵坑 ${code}`)
  return pit
}

console.log('1) 存量迁移：启泵水位缺项按同舱中位数补值 / 显式留空，按上次巡检日期迁移班次')
{
  freshDriver()
  const view = loadDrainage()
  const p4 = byCode('DRAI-0004')
  // 热力舱B段可参照启泵水位 1.80（仅 DRAI-0005 一条），中位数即 1.8
  check('DRAI-0004 启泵水位按同舱中位数补为 1.8', p4.启泵水位 === '1.8', p4.启泵水位)
  check('DRAI-0004 保留补值标记', p4.补录标记.includes('同舱中位数补值'))
  check('DRAI-0004 按巡检日 10-04 挂到 DUTY-0004', p4.值班台账 === 'DUTY-0004', p4.值班台账)

  const p6 = byCode('DRAI-0006')
  const p7 = byCode('DRAI-0007')
  check('电力舱C段无参照样本 → DRAI-0006 启泵水位显式留空', p6.启泵水位 === '')
  check('DRAI-0006 标记为显式留空-待核定', p6.补录标记.includes('显式留空'))
  check('DRAI-0007 启泵水位显式留空', p7.启泵水位 === '')
  check('C 段两坑按巡检日 10-05 挂到 DUTY-0005', p6.值班台账 === 'DUTY-0005' && p7.值班台账 === 'DUTY-0005')
  check('启泵水位缺项共 2 个（待核定）', view.stats['待核定启泵水位'] === 2, String(view.stats['待核定启泵水位']))
  check('存量迁移历史只追加（每个缺项都有记录）',
    view.history.filter((h) => h.操作 === '存量迁移').length >= 3)
}

console.log('2) 一次落库：列表与详情同源，刷新/退出重进仍是改过的版本')
{
  freshDriver()
  const before = byCode('DRAI-0001')
  const result = saveDrainagePit(before.id, {
    泵坑编号: 'DRAI-0001',
    集水坑容积: '12.0',
    当前水位: '0.95',
    启泵水位: '1.25',
  }, actor)
  check('保存成功', result.ok, result.message)
  const after = byCode('DRAI-0001')
  check('内存中读到新启泵水位 1.25', after.启泵水位 === '1.25')
  check('列表与详情同源（loadDrainage 只有一份）', loadDrainage().pits.every((pit) => pit.id !== before.id || pit.启泵水位 === '1.25'))

  reloadCache() // 模拟刷新：丢弃内存缓存，从 localStorage 重新读
  const reloaded = byCode('DRAI-0001')
  check('刷新后仍是新值 1.25（不回上一版）', reloaded.启泵水位 === '1.25', reloaded.启泵水位)
  check('历史追加了修改记录',
    loadDrainage().history.some((h) => h.泵坑编号 === 'DRAI-0001' && h.操作 === '修改泵坑参数' && h.说明.includes('1.25')))
}

console.log('3) 水位越过启泵线进入排水中；确认正常后待排水数回落，重复确认只回落一次')
{
  freshDriver()
  const p1 = byCode('DRAI-0001')
  // 初始开放泵坑：DRAI-0002(待排水)、DRAI-0003(排水中)、DRAI-0006、DRAI-0007(待排水)，故障不计
  check('初始待排水数（待排水+排水中，不含故障）', loadDrainage().stats['待排水泵坑'] === 4, String(loadDrainage().stats['待排水泵坑']))

  // 把 DRAI-0001 当前水位调到越过启泵线
  const over = saveDrainagePit(p1.id, {
    泵坑编号: 'DRAI-0001',
    集水坑容积: '12.0',
    当前水位: '1.62',
    启泵水位: '1.50',
  }, actor)
  check('越线保存成功', over.ok, over.message)
  check('越线后自动进入排水中', byCode('DRAI-0001').status === '排水中')

  const first = runDrainageAction(byCode('DRAI-0001').id, '确认正常', actor)
  check('确认正常成功', first.ok, first.message)
  check('确认后状态为水位正常', byCode('DRAI-0001').status === '水位正常')
  const countAfterFirst = loadDrainage().stats['待排水泵坑']
  check('确认后待排水数回落', countAfterFirst === 4, String(countAfterFirst))

  const second = runDrainageAction(byCode('DRAI-0001').id, '确认正常', actor)
  check('重复确认被拒绝、不再回落', !second.ok && second.message.includes('重复确认'))
  check('待排水数不变', loadDrainage().stats['待排水泵坑'] === countAfterFirst)
}

console.log('4) 补录启泵水位：缺项补齐、待办核销、历史按原口径保留')
{
  freshDriver()
  const p6 = byCode('DRAI-0006')
  const beforeTodos = loadDrainage().todos.length
  check('补录前存在启泵水位待补录待办', loadDrainage().todos.some((t) => t.泵坑编号 === 'DRAI-0006' && t.kind === '启泵水位待补录'))

  // 缺项不补齐：启泵水位仍留空保存（允许保留显式留空，不改变待核定状态）
  const keepBlank = saveDrainagePit(p6.id, {
    泵坑编号: 'DRAI-0006',
    集水坑容积: '11.0',
    当前水位: '1.10',
    启泵水位: '',
  }, actor)
  check('允许保留显式留空（不伪造数值）', keepBlank.ok && byCode('DRAI-0006').启泵水位 === '')
  check('留空时补录待办仍在', loadDrainage().todos.some((t) => t.泵坑编号 === 'DRAI-0006' && t.kind === '启泵水位待补录'))

  const saved = saveDrainagePit(p6.id, {
    泵坑编号: 'DRAI-0006',
    集水坑容积: '11.0',
    当前水位: '1.10',
    启泵水位: '1.35',
  }, actor)
  check('补录成功', saved.ok, saved.message)
  const after = byCode('DRAI-0006')
  check('启泵水位已补为 1.35', after.启泵水位 === '1.35')
  check('补录标记更新为已补录', after.补录标记.includes('已补录'))
  check('补录待办核销', !loadDrainage().todos.some((t) => t.泵坑编号 === 'DRAI-0006' && t.kind === '启泵水位待补录'))
  check('待办条数较补录前减少', loadDrainage().todos.length === beforeTodos - 1, `${loadDrainage().todos.length} vs ${beforeTodos}`)
  const hist = loadDrainage().history.filter((h) => h.泵坑编号 === 'DRAI-0006').map((h) => h.操作)
  check('历史中原「存量迁移」记录仍保留，且追加补录记录', hist.includes('存量迁移') && hist.includes('补录启泵水位') && hist.includes('补录归档'))
}

console.log('5) 对账结论待办条数与值班台账对得上；对账幂等')
{
  freshDriver()
  const view = runDrainageReconcile(actor)
  const sumByLedger = view.report.todoCountByLedger.reduce((sum, item) => sum + item.待办数, 0)
  check('台账分组待办合计 == 待办总条数', sumByLedger === view.todos.length, `${sumByLedger} vs ${view.todos.length}`)
  check('待办全部挂在真实台账', view.report.ledgerMatched)
  const expected = [
    { code: 'DUTY-0002', n: 1 }, // DRAI-0005 故障（巡检 10-02）
    { code: 'DUTY-0003', n: 1 }, // DRAI-0002 越线（巡检 10-03）
    { code: 'DUTY-0005', n: 3 }, // DRAI-0003 排水中 + DRAI-0006/DRAI-0007 两条缺项（巡检 10-05）
  ]
  for (const item of expected) {
    const got = view.report.todoCountByLedger.find((g) => g.交接编号 === item.code)?.待办数 ?? -1
    check(`${item.code} 挂 ${item.n} 条`, got === item.n, `got ${got}`)
  }
  const again = runDrainageReconcile(actor)
  check('再次对账待办条数不变（幂等）', again.todos.length === view.todos.length)
  check('同一泵坑同类待办只有一条（稳定ID）', new Set(again.todos.map((t) => t.id)).size === again.todos.length)
}

console.log('6) 存量台账按交接班次迁移；待办清单与值班台账同步变化')
{
  freshDriver()
  const before = loadDrainage()
  const openLedger6 = before.report.todoCountByLedger.find((g) => g.交接编号 === 'DUTY-0006')?.待办数 ?? 0
  check('交接前当前班 DUTY-0006 无待办', openLedger6 === 0, String(openLedger6))

  // DRAI-0005 故障（挂 DUTY-0002）属于未闭环？故障不算 open；open = 待排水/排水中
  // 找到交接中台账 DUTY-0006（10-06 白班）并确认交接
  const result = confirmDutyHandover(6, actor)
  check('交接成功', result.ok, result.message)
  check('自动开出下一班台账（当日 10-06 夜班）', !!result.nextLedger && result.nextLedger['交接编号'] === 'DUTY-0007', String(result.nextLedger?.['交接编号']))
  check('下一班为夜班 20:00-次日08:00', String(result.nextLedger!['班次']).includes('夜班'))

  const after = loadDrainage()
  check('DUTY-0006 已关闭', (after.report.todoCountByLedger.find((g) => g.交接编号 === 'DUTY-0006')) !== undefined)
  const closedLedger = after.report.todoCountByLedger.find((g) => g.交接编号 === 'DUTY-0006')
  check('旧班台账待办归零（无 open 坑挂该班）', (closedLedger?.待办数 ?? -1) === 0)

  // 把 DRAI-0002（open，挂 DUTY-0003）改挂当前班不现实，直接验证：把当前班新登记一个越线坑后交接
  const reg = registerDrainagePit({
    泵坑编号: 'DRAI-0008',
    所属舱室: '综合舱A段',
    集水坑容积: '10',
    当前水位: '1.9',
    启泵水位: '1.4',
  }, actor)
  check('新登记越线坑成功', reg.ok, reg.message)
  check('新坑挂当前交接中班 DUTY-0007', byCode('DRAI-0008').值班台账 === 'DUTY-0007')
  const handover2 = confirmDutyHandover(7, actor)
  check('第二次交接成功', handover2.ok, handover2.message)
  check('未闭环泵坑随班迁移到 DUTY-0008（夜班后次日白班）', byCode('DRAI-0008').值班台账 === 'DUTY-0008', byCode('DRAI-0008').值班台账)
  check('下一班日期滚到 2026-10-07 白班', String(handover2.nextLedger!['值班日期']) === '2026-10-07' && String(handover2.nextLedger!['班次']).includes('白班'))
  const finalView = loadDrainage()
  const on08 = finalView.todos.filter((t) => t.值班台账 === 'DUTY-0008')
  check('待办随班出现在新台账 DUTY-0008', on08.some((t) => t.泵坑编号 === 'DRAI-0008'))
  const on07 = finalView.todos.filter((t) => t.值班台账 === 'DUTY-0007')
  check('旧台账 DUTY-0007 该坑待办已迁走', !on07.some((t) => t.泵坑编号 === 'DRAI-0008'))
  check('重复交接被拒绝', !confirmDutyHandover(6, actor).ok)
}

console.log('7) 超时/断线写入重试一次后成功；持续失败给出明确原因且不留半成品')
{
  const drv = memoryDriver({ setFailUntil: 1 })
  setStorageDriver(drv)
  const p1 = byCode('DRAI-0001')
  const result = saveDrainagePit(p1.id, {
    泵坑编号: 'DRAI-0001',
    集水坑容积: '12.0',
    当前水位: '0.7',
    启泵水位: '1.1',
  }, actor)
  check('首次失败、重试一次后成功', result.ok, result.message)
  check('存储中确实落了新值', reloadCache() && byCode('DRAI-0001').启泵水位 === '1.1')

  const alwaysFail = memoryDriver({ setFailUntil: Number.MAX_SAFE_INTEGER })
  setStorageDriver(alwaysFail)
  const bad = saveDrainagePit(byCode('DRAI-0001').id, {
    泵坑编号: 'DRAI-0001',
    集水坑容积: '12.0',
    当前水位: '0.3',
    启泵水位: '0.9',
  }, actor)
  check('持续失败返回明确原因', !bad.ok && bad.message.includes('已重试一次') && bad.message.includes('模拟断线'))
}

console.log('8) v1 旧数据升级：占位串按新种子播种，真实数据迁移保留')
{
  const drv = memoryDriver()
  const v1 = {
    tunnel: [{ id: 1, status: '运行中', pending: true, abnormal: false, 管廊编号: 'KEEP-0001' }],
    drainage: [
      {
        id: 1, status: '待排水', pending: true, abnormal: false,
        泵坑编号: 'OLD-0001', 所属舱室: '综合舱A段', 集水坑容积: '20', 当前水位: '2.1', 启泵水位: '1.9',
        排水泵编号: 'PUMP-OLD', 值班人员: '老员工', 排水状态: '待排水', 上次巡检日期: '2026-10-03',
      },
    ],
  }
  drv.setItem('urban-utility-tunnel:entries', JSON.stringify(v1))
  setStorageDriver(drv)
  reloadCache()
  check('真实 v1 泵坑迁移后仍在', !!byCode('OLD-0001'))
  const old = byCode('OLD-0001')
  check('真实 v1 泵坑水位越线 → 排水中', old.status === '排水中', old.status)
  check('真实 v1 泵坑按巡检日挂 DUTY-0003', old.值班台账 === 'DUTY-0003', old.值班台账)
  check('其它模块真实改动保留（tunnel 沿用 v1 数据）', require('@/data/local-store').listRows('tunnel')[0]['管廊编号'] === 'KEEP-0001')
  check('旧键已清理（只认 v2 一份）', drv.getItem('urban-utility-tunnel:entries') === null)
  check('新键已写入', drv.getItem(storageKey()) !== null)
}

console.log('9) 新登记校验：缺项一并补齐，编号唯一')
{
  freshDriver()
  const dup = registerDrainagePit({
    泵坑编号: 'DRAI-0001',
    所属舱室: '综合舱A段',
    集水坑容积: '10',
    当前水位: '0.5',
    启泵水位: '1',
  }, actor)
  check('泵坑编号重复被拒', !dup.ok && dup.message.includes('已存在'))
  const missing = registerDrainagePit({
    泵坑编号: 'DRAI-0099',
    所属舱室: '综合舱A段',
    集水坑容积: '10',
    当前水位: '',
    启泵水位: '1',
  }, actor)
  check('缺当前水位被拒（缺项一并补齐）', !missing.ok && missing.message.includes('当前水位不能为空'))
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
