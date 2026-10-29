import { Button, Input, Tooltip, Switch, Tabs } from '@heroui/react'

import BasePage from '@renderer/components/base/base-page'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import EditableList from '@renderer/components/base/base-list-editor'
import PacEditorModal from '@renderer/components/sysproxy/pac-editor-modal'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useSysProxyDrift } from '@renderer/hooks/use-sysproxy-drift'
import { platform } from '@renderer/utils/init'
import {
  forceRestoreNetwork,
  getAppConfig,
  openUWPTool,
  serviceStatus,
  triggerSysProxy
} from '@renderer/utils/ipc'
import React, { Key, useEffect, useState } from 'react'
import ByPassEditorModal from '@renderer/components/sysproxy/bypass-editor-modal'
import { IoIosHelpCircle } from 'react-icons/io'
import { LuTriangleAlert, LuCircleCheck } from 'react-icons/lu'
import { notify } from '@renderer/utils/notification'
import ConfirmModal from '@renderer/components/base/base-confirm'

const defaultPacScript = `
function FindProxyForURL(url, host) {
  return "PROXY 127.0.0.1:%mixed-port%; SOCKS5 127.0.0.1:%mixed-port%; DIRECT;";
}
`

const Sysproxy: React.FC = () => {
  const defaultBypass: string[] =
    platform === 'linux'
      ? [
          'localhost',
          '.local',
          '127.0.0.1/8',
          '192.168.0.0/16',
          '10.0.0.0/8',
          '172.16.0.0/12',
          '::1'
        ]
      : platform === 'darwin'
        ? [
            '127.0.0.1/8',
            '192.168.0.0/16',
            '10.0.0.0/8',
            '172.16.0.0/12',
            'localhost',
            '*.local',
            '*.crashlytics.com',
            '<local>'
          ]
        : [
            'localhost',
            '127.*',
            '192.168.*',
            '10.*',
            '172.16.*',
            '172.17.*',
            '172.18.*',
            '172.19.*',
            '172.20.*',
            '172.21.*',
            '172.22.*',
            '172.23.*',
            '172.24.*',
            '172.25.*',
            '172.26.*',
            '172.27.*',
            '172.28.*',
            '172.29.*',
            '172.30.*',
            '172.31.*',
            '<local>'
          ]

  const { appConfig, patchAppConfig, mutateAppConfig } = useAppConfig()
  const { sysProxy, onlyActiveDevice = false } =
    appConfig || ({ sysProxy: { enable: false } } as AppConfig)
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    enable: sysProxy.enable,
    host: sysProxy.host ?? '',
    bypass: sysProxy.bypass ?? defaultBypass,
    mode: sysProxy.mode ?? 'manual',
    pacScript: sysProxy.pacScript ?? defaultPacScript,
    settingMode: sysProxy.settingMode ?? 'exec',
    guard: sysProxy.guard ?? false,
    guardNotify: sysProxy.guardNotify ?? false
  })
  const syncValuesFromSysProxy = (nextSysProxy: AppConfig['sysProxy']): void => {
    originSetValues((prev) => ({
      ...prev,
      enable: nextSysProxy.enable,
      host: nextSysProxy.host ?? '',
      bypass: nextSysProxy.bypass ?? defaultBypass,
      mode: nextSysProxy.mode ?? 'manual',
      pacScript: nextSysProxy.pacScript ?? defaultPacScript,
      settingMode: nextSysProxy.settingMode ?? 'exec',
      guard: nextSysProxy.guard ?? false,
      guardNotify: nextSysProxy.guardNotify ?? false
    }))
  }
  useEffect(() => {
    syncValuesFromSysProxy(sysProxy)
  }, [sysProxy])
  const [openEditor, setOpenEditor] = useState(false)
  const [openPacEditor, setOpenPacEditor] = useState(false)
  const [openRestoreConfirm, setOpenRestoreConfirm] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const { drift, refresh: refreshDrift } = useSysProxyDrift()

  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const normalizeServiceModeValues = async (): Promise<typeof values> => {
    if (values.settingMode !== 'service') {
      return values
    }

    const status = await serviceStatus().catch(() => 'unknown' as const)
    if (status === 'running') {
      return values
    }

    notify('服务不可用，已切换到执行命令模式')
    const nextValues = {
      ...values,
      settingMode: 'exec' as const,
      guard: false,
      guardNotify: false
    }
    originSetValues(nextValues)
    return nextValues
  }

  const onSave = async (): Promise<void> => {
    // check valid TODO
    const nextValues = await normalizeServiceModeValues()
    const nextConfig =
      (await patchAppConfig({ sysProxy: nextValues })) ?? (await getAppConfig(true))
    syncValuesFromSysProxy(nextConfig.sysProxy)
    mutateAppConfig()
    setChanged(false)
    if (nextConfig.sysProxy.enable) {
      try {
        await triggerSysProxy(nextConfig.sysProxy.enable, onlyActiveDevice)
      } catch (e) {
        notify(e, { variant: 'danger' })
        await patchAppConfig({ sysProxy: { enable: false } })
      }
    }
  }

  const onForceRestore = async (): Promise<void> => {
    setRestoring(true)
    try {
      const result = await forceRestoreNetwork()
      mutateAppConfig()
      await refreshDrift()

      if (result.errors.length > 0) {
        notify(`部分项目未能恢复：${result.errors.join('；')}`, {
          variant: 'warning',
          timeout: 10000
        })
      } else {
        notify(result.dnsRestored ? '已清除系统代理并还原 DNS' : '已清除系统代理设置', {
          variant: 'success'
        })
      }
    } catch (e) {
      notify(e, { variant: 'danger' })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <BasePage
      title="系统代理设置"
      contentClassName="no-scrollbar"
      header={
        changed && (
          <Button
            size="sm"
            onPress={onSave}
            variant="primary"
            data-color="primary"
            className="app-nodrag"
          >
            保存
          </Button>
        )
      }
    >
      {openPacEditor && (
        <PacEditorModal
          script={values.pacScript || defaultPacScript}
          onCancel={() => setOpenPacEditor(false)}
          onConfirm={(script: string) => {
            setValues({ ...values, pacScript: script })
            setOpenPacEditor(false)
          }}
        />
      )}
      {openEditor && (
        <ByPassEditorModal
          bypass={values.bypass}
          onCancel={() => setOpenEditor(false)}
          onConfirm={async (list: string[]) => {
            setOpenEditor(false)
            setValues({
              ...values,
              bypass: list
            })
          }}
        />
      )}
      {openRestoreConfirm && (
        <ConfirmModal
          onChange={setOpenRestoreConfirm}
          title="强制恢复网络配置？"
          description={
            <div className="space-y-2 text-sm">
              <p>
                将立即关闭 PAC 服务与系统代理守护，并对
                <span className="font-medium">所有网络服务</span>
                清除 HTTP / HTTPS / SOCKS 代理与自动代理（PAC）设置
                {platform === 'darwin' && '，同时把 DNS 还原为使用本应用前的值'}。
              </p>
              <p className="text-warning">
                此操作不做任何检查：即使当前显示代理已关闭也会执行，用于应用崩溃或强制退出后系统代理残留、
                导致整机断网的情况。
              </p>
              <p className="text-muted">
                若你原本使用其它代理软件（如公司代理、Surge、Clash
                Verge），其代理设置也会被清除，需要在该软件中重新开启。
              </p>
            </div>
          }
          confirmText={restoring ? '正在恢复…' : '强制恢复'}
          cancelText="取消"
          onConfirm={onForceRestore}
        />
      )}
      <SettingCard className="sysproxy-settings">
        <SettingItem compatKey="legacy" title="代理主机" divider>
          <Input
            value={values.host}
            placeholder="默认 127.0.0.1 若无特殊需求请勿修改"
            onChange={(event) => {
              const v = event.target.value
              setValues({ ...values, host: v })
            }}
            className="w-[50%]"
            fullWidth
          />
        </SettingItem>
        <SettingItem compatKey="legacy" title="代理模式" divider>
          <Tabs
            selectedKey={values.mode}
            onSelectionChange={(key: Key) => setValues({ ...values, mode: key as SysProxyMode })}
            data-color="primary"
            data-size="sm"
            data-full-width={false}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="选项">
                <Tabs.Tab key="manual" id="manual">
                  手动
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab key="auto" id="auto">
                  PAC
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </SettingItem>
        {platform === 'win32' && (
          <SettingItem compatKey="legacy" title="UWP 工具" divider>
            <Button
              size="sm"
              onPress={async () => {
                await openUWPTool()
              }}
              variant="primary"
              data-color="default"
            >
              打开 UWP 工具
            </Button>
          </SettingItem>
        )}
        <SettingItem compatKey="legacy" title="设置方式" divider>
          <Tabs
            selectedKey={values.settingMode}
            onSelectionChange={(key) => {
              const settingMode = key as 'exec' | 'service'
              setValues({
                ...values,
                settingMode,
                guard: settingMode === 'service' ? values.guard : false,
                guardNotify: settingMode === 'service' ? values.guardNotify : false
              })
            }}
            data-color="primary"
            data-size="sm"
            data-full-width={false}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="选项">
                <Tabs.Tab key="exec" id="exec">
                  执行命令
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab key="service" id="service">
                  服务模式
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </SettingItem>
        {platform !== 'linux' && (
          <SettingItem
            compatKey="legacy"
            title="仅为活跃接口设置"
            actions={
              <Tooltip delay={0}>
                <Button isIconOnly size="sm" variant="ghost" data-color="default">
                  <IoIosHelpCircle className="text-lg" />
                </Button>
                <Tooltip.Content>
                  {
                    <>
                      <div>
                        开启后，系统代理仅为当前已启用的网络接口设置，跳过未连接/未启用的接口（如未插卡的
                        iPhone USB、Tailscale、Surge），可显著加快开关速度
                      </div>
                    </>
                  }
                </Tooltip.Content>
              </Tooltip>
            }
            divider
          >
            <Switch
              size="sm"
              isSelected={onlyActiveDevice}
              onChange={(v) => {
                patchAppConfig({ onlyActiveDevice: v })
              }}
              aria-label="仅为活跃接口设置"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </SettingItem>
        )}
        {values.settingMode === 'service' && (
          <SettingItem
            compatKey="legacy"
            title="系统代理守护"
            actions={
              <Tooltip delay={0}>
                <Button isIconOnly size="sm" variant="ghost" data-color="default">
                  <IoIosHelpCircle className="text-lg" />
                </Button>
                <Tooltip.Content>
                  {<div>检测到系统代理被修改后自动恢复，仅服务模式下生效</div>}
                </Tooltip.Content>
              </Tooltip>
            }
            divider
          >
            <Switch
              size="sm"
              isSelected={values.guard}
              onChange={(v) => {
                setValues({ ...values, guard: v, guardNotify: v ? values.guardNotify : false })
              }}
              aria-label="系统代理守护"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </SettingItem>
        )}
        {values.settingMode === 'service' && values.guard && (
          <SettingItem
            compatKey="legacy"
            title="守护通知"
            actions={
              <Tooltip delay={0}>
                <Button isIconOnly size="sm" variant="ghost" data-color="default">
                  <IoIosHelpCircle className="text-lg" />
                </Button>
                <Tooltip.Content>{<div>系统代理恢复成功或失败时发送通知</div>}</Tooltip.Content>
              </Tooltip>
            }
            divider
          >
            <Switch
              size="sm"
              isSelected={values.guardNotify}
              isDisabled={!values.guard}
              onChange={(v) => {
                setValues({ ...values, guardNotify: v })
              }}
              aria-label="守护通知"
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </SettingItem>
        )}
        {values.mode === 'auto' && (
          <SettingItem compatKey="legacy" title="代理模式">
            <Button
              size="sm"
              onPress={() => setOpenPacEditor(true)}
              variant="primary"
              data-color="default"
            >
              编辑 PAC 脚本
            </Button>
          </SettingItem>
        )}
        {values.mode === 'manual' && (
          <>
            <SettingItem compatKey="legacy" title="添加默认代理绕过" divider>
              <Button
                size="sm"
                onPress={() => {
                  setValues({
                    ...values,
                    bypass: Array.from(new Set([...defaultBypass, ...values.bypass]))
                  })
                }}
                variant="primary"
                data-color="default"
              >
                添加默认代理绕过
              </Button>
            </SettingItem>
            <SettingItem compatKey="legacy" title="代理绕过列表">
              <Button
                size="sm"
                onPress={async () => {
                  setOpenEditor(true)
                }}
                variant="primary"
                data-color="default"
              >
                编辑
              </Button>
            </SettingItem>
            <EditableList
              items={values.bypass}
              onChange={(list) => setValues({ ...values, bypass: list as string[] })}
              placeholder="例：*.baidu.com"
              divider={false}
            />
          </>
        )}
      </SettingCard>

      <SettingCard className="sysproxy-restore">
        <SettingItem
          compatKey="legacy"
          title="强制恢复网络配置"
          actions={
            <Tooltip delay={0}>
              <Button isIconOnly size="sm" variant="ghost" data-color="default">
                <IoIosHelpCircle className="text-lg" />
              </Button>
              <Tooltip.Content>
                {
                  <div className="max-w-64">
                    应用异常退出、系统代理残留导致整机断网时使用。会立即清除所有网络服务上的代理设置，
                    {platform === 'darwin' ? '并把 DNS 还原为使用前的值。' : '不做可用性检查。'}
                  </div>
                }
              </Tooltip.Content>
            </Tooltip>
          }
          divider
        >
          <Button
            size="sm"
            variant="danger"
            isPending={restoring}
            isDisabled={restoring}
            onPress={() => setOpenRestoreConfirm(true)}
          >
            {restoring ? '正在恢复…' : '强制恢复'}
          </Button>
        </SettingItem>
        <SettingItem compatKey="legacy" title="当前状态">
          <div className="text-sm">
            {!drift ? (
              <span className="text-muted">检测中…</span>
            ) : !drift.supported ? (
              <span className="text-muted">
                {sysProxy.enable ? '系统代理已开启' : '系统代理已关闭'}
                <span className="ml-1 text-xs">（当前平台不支持自动检测）</span>
              </span>
            ) : drift.ok ? (
              <span className="flex items-center gap-1 text-success">
                <LuCircleCheck className="text-[14px]" />
                {sysProxy.enable ? '系统代理已开启，与配置一致' : '系统代理已关闭，无残留'}
              </span>
            ) : (
              <div className="space-y-1">
                {drift.issues.map((issue, index) => (
                  <div
                    key={`${issue.service}-${issue.kind}-${index}`}
                    className={`flex items-start gap-1 ${
                      issue.kind === 'stale' ? 'text-danger' : 'text-warning'
                    }`}
                  >
                    <LuTriangleAlert className="mt-0.5 shrink-0 text-[14px]" />
                    <span>
                      {issue.detail}
                      {issue.kind === 'stale' && '（可能导致无法上网）'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SettingItem>
      </SettingCard>
    </BasePage>
  )
}

export default Sysproxy
