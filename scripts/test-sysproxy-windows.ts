/**
 * 系统代理漂移检测的 Windows 验证脚本。
 *
 * 跑在 windows-latest runner 上，分两层：
 *
 * 1. 纯判定逻辑：用构造的输入直接调 evaluateWindowsDrift，四个分支都覆盖，
 *    这一层在任何平台都能跑，用来防回归。
 * 2. 真实注册表往返：在本机真的写 HKCU 的 ProxyEnable / ProxyServer，
 *    再用 readWindowsSystemProxy 读回来，验证 reg query 的解析没有写错。
 *    runner 是一次性的，改注册表不影响任何东西，退出前会还原。
 *
 * 用法：tsx scripts/test-sysproxy-windows.ts
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  evaluateWindowsDrift,
  WINDOWS_INTERNET_SETTINGS_KEY,
  readWindowsSystemProxy
} from '../src/main/sys/winproxy'
import type { WindowsSystemProxy } from '../src/main/sys/winproxy'

const execFilePromise = promisify(execFile)

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`)
  }
}

/** 构造一个 WindowsSystemProxy，省得每处都写全字段 */
function proxy(patch: Partial<WindowsSystemProxy>): WindowsSystemProxy {
  return { enabled: false, server: '', bypass: '', ...patch }
}

function testEvaluationLogic(): void {
  console.log('\n[1] 判定逻辑')

  // 配置关闭 + 系统关闭 → 一致
  check('关闭/关闭 → ok', evaluateWindowsDrift(proxy({}), null, 'manual').ok, true)

  // 配置关闭 + 系统仍开着 → stale（会导致断网的那种）
  const stale = evaluateWindowsDrift(
    proxy({ enabled: true, server: '127.0.0.1:7890' }),
    null,
    'manual'
  )
  check(
    '关闭/仍开着 → stale',
    stale.issues.map((i) => i.kind),
    ['stale']
  )
  check('stale 时 ok 为 false', stale.ok, false)
  check('stale 时 enabledCount 为 1', stale.enabledCount, 1)

  // 配置开启 + 系统未开 → missing
  const missing = evaluateWindowsDrift(proxy({}), '127.0.0.1:7890', 'manual')
  check(
    '开启/未生效 → missing',
    missing.issues.map((i) => i.kind),
    ['missing']
  )

  // 配置开启 + 地址不符 → mismatch
  const mismatch = evaluateWindowsDrift(
    proxy({ enabled: true, server: '127.0.0.1:9999' }),
    '127.0.0.1:7890',
    'manual'
  )
  check(
    '开启/地址不符 → mismatch',
    mismatch.issues.map((i) => i.kind),
    ['mismatch']
  )

  // 配置开启 + 地址一致 → 一致
  const match = evaluateWindowsDrift(
    proxy({ enabled: true, server: '127.0.0.1:7890' }),
    '127.0.0.1:7890',
    'manual'
  )
  check('开启/地址一致 → ok', match.ok, true)

  // PAC 模式只看「有没有开」，不比对地址
  const pac = evaluateWindowsDrift(
    proxy({ enabled: true, server: '127.0.0.1:7890' }),
    'pac',
    'auto'
  )
  check('PAC 模式不比对地址', pac.ok, true)

  // PAC 模式但系统没开 → 仍然要报 missing
  const pacMissing = evaluateWindowsDrift(proxy({}), 'pac', 'auto')
  check('PAC 模式未生效不误报', pacMissing.ok, true)
}

async function setRegistry(
  value: string,
  type: 'REG_DWORD' | 'REG_SZ',
  data: string
): Promise<void> {
  await execFilePromise('reg', [
    'add',
    WINDOWS_INTERNET_SETTINGS_KEY,
    '/v',
    value,
    '/t',
    type,
    '/d',
    data,
    '/f'
  ])
}

async function deleteRegistry(value: string): Promise<void> {
  try {
    await execFilePromise('reg', ['delete', WINDOWS_INTERNET_SETTINGS_KEY, '/v', value, '/f'])
  } catch {
    // 本来就不存在
  }
}

async function testRegistryRoundTrip(): Promise<void> {
  console.log('\n[2] 真实注册表往返')

  if (process.platform !== 'win32') {
    console.log('  - 跳过：当前不是 Windows')
    return
  }

  // 先备份原值，结束后还原
  const before = await readWindowsSystemProxy()
  console.log(`  当前: enabled=${before.enabled} server=${JSON.stringify(before.server)}`)

  try {
    console.log('  写入 127.0.0.1:7890 并启用')
    await setRegistry('ProxyEnable', 'REG_DWORD', '1')
    await setRegistry('ProxyServer', 'REG_SZ', '127.0.0.1:7890')

    const read = await readWindowsSystemProxy()
    check('读回 enabled', read.enabled, true)
    check('读回 server', read.server, '127.0.0.1:7890')

    // 用真实读到的值跑一遍判定：配置关闭时必须是 stale
    const drift = evaluateWindowsDrift(read, null, 'manual')
    check(
      '真机值 → 判为 stale',
      drift.issues.map((i) => i.kind),
      ['stale']
    )

    // 暂存（discovery）模式：有的系统把 ProxyServer 存成每个协议一段
    console.log('  写入多协议形式')
    await setRegistry('ProxyServer', 'REG_SZ', 'http=127.0.0.1:7890;https=127.0.0.1:7890')
    const multi = await readWindowsSystemProxy()
    check('多协议值原样读出', multi.server, 'http=127.0.0.1:7890;https=127.0.0.1:7890')

    console.log('  关闭代理')
    await setRegistry('ProxyEnable', 'REG_DWORD', '0')
    const off = await readWindowsSystemProxy()
    check('关闭后 enabled 为 false', off.enabled, false)
  } finally {
    // 还原
    console.log('  还原注册表')
    if (before.enabled) {
      await setRegistry('ProxyEnable', 'REG_DWORD', '1').catch(() => {})
    } else {
      await setRegistry('ProxyEnable', 'REG_DWORD', '0').catch(() => {})
    }
    if (before.server) {
      await setRegistry('ProxyServer', 'REG_SZ', before.server).catch(() => {})
    } else {
      await deleteRegistry('ProxyServer')
    }
  }
}

async function main(): Promise<void> {
  console.log(`平台: ${process.platform}`)
  testEvaluationLogic()
  await testRegistryRoundTrip()

  console.log('')
  if (failures > 0) {
    console.error(`✗ ${failures} 项失败`)
    process.exit(1)
  }
  console.log('✓ 全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
