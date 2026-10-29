import { Button, Card } from '@heroui/react'

import BorderSwitch from '@renderer/components/base/border-swtich'
import { useLocation } from 'react-router-dom'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useSysProxyDrift } from '@renderer/hooks/use-sysproxy-drift'
import { forceRestoreNetwork, triggerSysProxy } from '@renderer/utils/ipc'
import { AiOutlineGlobal } from 'react-icons/ai'
import { LuTriangleAlert } from 'react-icons/lu'
import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { notify } from '@renderer/utils/notification'
import SiderItem from './sider-item'

interface Props {
  iconOnly?: boolean
  expanded?: boolean
}

const SysproxySwitcher: React.FC<Props> = (props) => {
  const { iconOnly, expanded } = props
  const location = useLocation()
  const match = location.pathname.includes('/sysproxy')
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    sysProxy,
    sysproxyCardStatus = 'col-span-1',
    onlyActiveDevice = false,
    disableAnimation = false
  } = appConfig || {}
  const { enable, mode } = sysProxy || {}
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { 'mixed-port': mixedPort } = controledMihomoConfig || {}
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: 'sysproxy'
  })

  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null
  const disabled = mixedPort == 0
  const [pendingEnable, setPendingEnable] = React.useState<boolean | null>(null)
  const pending = pendingEnable !== null
  const displayEnable = pendingEnable ?? enable
  const { drift, refresh: refreshDrift } = useSysProxyDrift()

  // 「配置说关着，系统上却还留着」会直接断网，是必须让用户看见的那种问题；
  // 其余漂移（未生效、地址被改）只提示，不升级成危险色。
  const stale = !!drift?.issues.some((issue) => issue.kind === 'stale')
  const drifted = !!drift?.supported && !drift.ok
  const driftSummary = drifted ? drift.issues.map((issue) => issue.detail).join('\n') : ''

  const onForceRestore = async (): Promise<void> => {
    try {
      const result = await forceRestoreNetwork()
      await refreshDrift()
      window.electron.ipcRenderer.send('updateFloatingWindow')
      window.electron.ipcRenderer.send('updateTrayMenu')
      notify(
        result.errors.length > 0
          ? `已恢复，但有 ${result.errors.length} 项失败：${result.errors.join('；')}`
          : result.dnsRestored
            ? '已清除系统代理并还原 DNS'
            : '已清除系统代理设置',
        { variant: result.errors.length > 0 ? 'warning' : 'success', timeout: 8000 }
      )
    } catch (e) {
      notify(e, { variant: 'danger' })
    }
  }

  const onChange = async (enable: boolean): Promise<void> => {
    if (pending) return
    if (mode == 'manual' && disabled) return
    // 先把开关切到目标状态并锁定，避免等待系统调用时出现「点了没反应」
    setPendingEnable(enable)
    try {
      await triggerSysProxy(enable, onlyActiveDevice)
      await patchAppConfig({ sysProxy: { enable } })
      window.electron.ipcRenderer.send('updateFloatingWindow')
      window.electron.ipcRenderer.send('updateTrayMenu')
    } catch (e) {
      notify(e, { variant: 'danger' })
    } finally {
      setPendingEnable(null)
      await refreshDrift()
    }
  }

  if (iconOnly) {
    return (
      <SiderItem
        className={sysproxyCardStatus}
        title={drifted ? `系统代理 · ${stale ? '代理残留' : '状态异常'}` : '系统代理'}
        route="/sysproxy"
        icon={
          <div className="relative">
            <AiOutlineGlobal className="text-[20px]" />
            {drifted && (
              <span
                className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ${
                  stale ? 'bg-danger' : 'bg-warning'
                }`}
              />
            )}
          </div>
        }
        expanded={expanded}
      >
        <BorderSwitch
          isShowBorder={match && displayEnable}
          isSelected={!(mode != 'auto' && disabled) && displayEnable}
          isDisabled={pending || (mode == 'manual' && disabled)}
          onValueChange={onChange}
        />
      </SiderItem>
    )
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
      className={`${sysproxyCardStatus} sysproxy-card`}
    >
      <Card
        {...attributes}
        {...listeners}
        className={[
          'w-full',
          `${match ? 'bg-primary' : 'hover:bg-primary/30'} ${isDragging ? `${disableAnimation ? '' : 'scale-[0.95]'} tap-highlight-transparent` : ''}`
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Card.Content className="pb-1 pt-0 px-0 overflow-y-visible">
          <div className="flex justify-between">
            <Button
              isIconOnly
              variant="secondary"
              data-color="default"
              className="bg-transparent pointer-events-none"
            >
              <AiOutlineGlobal
                className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px] font-bold`}
              />
            </Button>
            <BorderSwitch
              isShowBorder={match && displayEnable}
              isSelected={!(mode != 'auto' && disabled) && displayEnable}
              isDisabled={pending || (mode == 'manual' && disabled)}
              onValueChange={onChange}
            />
          </div>
        </Card.Content>
        <Card.Footer className="pt-1">
          <h3
            className={`text-md font-bold ${match ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            系统代理
          </h3>
        </Card.Footer>
        {drifted && (
          <Card.Footer className="pt-0">
            <button
              type="button"
              // 卡片整体在拖拽监听里，这里要拦住事件，否则点提示会变成拖动
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                onForceRestore()
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={driftSummary}
              className={`app-nodrag flex w-full items-start gap-1 text-left text-xs ${
                stale ? 'text-danger' : 'text-warning'
              }`}
            >
              <LuTriangleAlert className="mt-0.5 shrink-0 text-[12px]" />
              <span className="leading-tight">{stale ? '代理残留，点此恢复' : '代理状态异常'}</span>
            </button>
          </Card.Footer>
        )}
      </Card>
    </div>
  )
}

export default SysproxySwitcher
