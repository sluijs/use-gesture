import { CoordinatesEngine } from './CoordinatesEngine'
import { coordinatesConfigResolver } from '../config/coordinatesConfigResolver'
import { pointerId, pointerValues } from '../utils/events'
import { V } from '../utils/maths'
import { Vector2 } from '../types'

const DISPLACEMENT = 10

const KEYS_DELTA_MAP = {
  ArrowRight: (factor = 1) => [DISPLACEMENT * factor, 0],
  ArrowLeft: (factor = 1) => [-DISPLACEMENT * factor, 0],
  ArrowUp: (factor = 1) => [0, -DISPLACEMENT * factor],
  ArrowDown: (factor = 1) => [0, DISPLACEMENT * factor]
}

export class DragEngine extends CoordinatesEngine<'drag'> {
  ingKey = 'dragging' as const

  // superseeds generic Engine reset call
  reset(this: DragEngine) {
    super.reset()
    const state = this.state
    state._pointerId = undefined
    state._pointerActive = false
    state._keyboardActive = false
    state._preventScroll = false
    state._delayed = false
    state.swipe = [0, 0]
    state.tap = false
    state.canceled = false
    state.cancel = this.cancel.bind(this)
  }

  setup() {
    const state = this.state

    if (state._bounds instanceof HTMLElement) {
      const boundRect = state._bounds.getBoundingClientRect()
      const targetRect = (state.currentTarget as HTMLElement).getBoundingClientRect()
      const _bounds = {
        left: boundRect.left - targetRect.left + state.offset[0],
        right: boundRect.right - targetRect.right + state.offset[0],
        top: boundRect.top - targetRect.top + state.offset[1],
        bottom: boundRect.bottom - targetRect.bottom + state.offset[1]
      }
      state._bounds = coordinatesConfigResolver.bounds(_bounds) as [Vector2, Vector2]
    }
  }

  cancel() {
    const state = this.state
    if (state.canceled) return
    setTimeout(() => {
      state.canceled = true
      state._active = false
      // we run compute with no event so that kinematics won't be computed
      this.compute()
      this.emit()
    }, 0)
  }

  setActive() {
    this.state._active = this.state._pointerActive || this.state._keyboardActive
  }

  // superseeds Engine clean function
  clean() {
    this.pointerClean()
    this.state._pointerActive = false
    this.state._keyboardActive = false
    super.clean()
  }

  pointerDown(event: PointerEvent) {
    // if (event.buttons != null && event.buttons % 2 !== 1) return
    this.ctrl.setEventIds(event)
    // We need to capture all pointer ids so that we can keep track of them when
    // they're released off the target
    if (this.config.pointerCapture) {
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    }

    const state = this.state
    const config = this.config

    if (state._pointerActive) return

    this.start(event)
    this.setupPointer(event)

    state._pointerId = pointerId(event)
    state._pointerActive = true

    state.values = pointerValues(event)
    state.initial = state.values

    if (config.preventScroll) {
      this.setupScrollPrevention(event)
    } else if (config.delay > 0) {
      this.setupDelayTrigger(event)
    } else {
      this.startPointerDrag(event)
    }
  }

  startPointerDrag(event: PointerEvent) {
    const state = this.state
    state._active = true
    state._preventScroll = true
    state._delayed = false

    this.compute(event)
    this.emit()
  }

  pointerMove(event: PointerEvent) {
    const state = this.state
    const config = this.config

    if (!state._pointerActive) return

    // if the event has the same timestamp as the previous event
    // note that checking type equality is ONLY for tests ¯\_(ツ)_/¯
    if (state.type === event.type && event.timeStamp === state.timeStamp) return

    const id = pointerId(event)
    if (state._pointerId && id !== state._pointerId) return

    const values = pointerValues(event)

    if (document.pointerLockElement === event.target) {
      state._delta = [event.movementX, event.movementY]
    } else {
      state._delta = V.sub(values, state.values)
      state.values = values
    }

    V.addTo(state._movement, state._delta)
    this.compute(event)

    if (state._delayed) {
      this.timeoutStore.remove('dragDelay')
      this.startPointerDrag(event)
      return
    }

    if (config.preventScroll && !state._preventScroll) {
      if (state.axis) {
        if (state.axis === config.preventScrollAxis || config.preventScrollAxis === 'xy') {
          state._active = false
          this.clean()
          return
        } else {
          this.timeoutStore.remove('startPointerDrag')
          this.startPointerDrag(event)
          return
        }
      } else {
        return
      }
    }

    this.emit()
  }

  pointerUp(event: PointerEvent) {
    this.ctrl.setEventIds(event)
    // We release the pointer id if it has pointer capture
    try {
      if (this.config.pointerCapture && (event.target as HTMLElement).hasPointerCapture(event.pointerId)) {
        ;(event.target as HTMLElement).releasePointerCapture(event.pointerId)
      }
    } catch {
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.warn(
          `[@use-gesture]: If you see this message, it's likely that you're using an outdated version of \`@react-three/fiber\`. \n\nPlease upgrade to the latest version.`
        )
      }
    }

    const state = this.state
    const config = this.config

    if (!state._pointerActive) return
    const id = pointerId(event)
    if (state._pointerId && id !== state._pointerId) return

    this.state._pointerActive = false
    this.setActive()
    this.compute(event)

    const [dx, dy] = state._distance
    state.tap = dx <= 3 && dy <= 3

    if (state.tap && config.filterTaps) {
      state._force = true
    } else {
      const [dirx, diry] = state.direction
      const [vx, vy] = state.velocity
      const [mx, my] = state.movement
      const [svx, svy] = config.swipe.velocity
      const [sx, sy] = config.swipe.distance
      const sdt = config.swipe.duration

      if (state.elapsedTime < sdt) {
        if (Math.abs(vx) > svx && Math.abs(mx) > sx) state.swipe[0] = dirx
        if (Math.abs(vy) > svy && Math.abs(my) > sy) state.swipe[1] = diry
      }
    }

    this.emit()
  }

  pointerClick(event: MouseEvent) {
    if (!this.state.tap) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  setupPointer(event: PointerEvent) {
    const config = this.config
    let device = config.device

    if (process.env.NODE_ENV === 'development') {
      try {
        if (device === 'pointer') {
          // @ts-ignore (warning for r3f)
          const currentTarget = 'uv' in event ? event.sourceEvent.currentTarget : event.currentTarget
          const style = window.getComputedStyle(currentTarget)
          if (style.touchAction === 'auto') {
            // eslint-disable-next-line no-console
            console.warn(
              `[@use-gesture]: The drag target has its \`touch-action\` style property set to \`auto\`. It is recommended to add \`touch-action: 'none'\` so that the drag gesture behaves correctly on touch-enabled devices. For more information read this: https://use-gesture.netlify.app/docs/extras/#touch-action.\n\nThis message will only show in development mode. It won't appear in production. If this is intended, you can ignore it.`,
              currentTarget
            )
          }
        }
      } catch {}
    }

    if (config.pointerLock) {
      ;(event.currentTarget as HTMLElement).requestPointerLock()
    }

    if (!config.pointerCapture) {
      this.eventStore.add(this.sharedConfig.window!, device, 'change', this.pointerMove.bind(this))
      this.eventStore.add(this.sharedConfig.window!, device, 'end', this.pointerUp.bind(this))
    }
  }

  pointerClean() {
    if (this.config.pointerLock && document.pointerLockElement === this.state.currentTarget) {
      document.exitPointerLock()
    }
  }

  preventScroll(event: PointerEvent) {
    if (this.state._preventScroll && event.cancelable) {
      event.preventDefault()
    }
  }

  setupScrollPrevention(event: PointerEvent) {
    persistEvent(event)
    // we add window listeners that will prevent the scroll when the user has started dragging
    this.eventStore.add(this.sharedConfig.window!, 'touch', 'change', this.preventScroll.bind(this), { passive: false })
    this.eventStore.add(this.sharedConfig.window!, 'touch', 'end', this.clean.bind(this), { passive: false })
    this.eventStore.add(this.sharedConfig.window!, 'touch', 'cancel', this.clean.bind(this), { passive: false })
    this.timeoutStore.add('startPointerDrag', this.startPointerDrag.bind(this), this.config.preventScroll, event)
  }

  setupDelayTrigger(event: PointerEvent) {
    this.state._delayed = true
    this.timeoutStore.add('dragDelay', this.startPointerDrag.bind(this), this.config.delay, event)
  }

  keyDown(event: KeyboardEvent) {
    // @ts-ignore
    const deltaFn = KEYS_DELTA_MAP[event.key]
    const state = this.state
    if (deltaFn) {
      const factor = event.shiftKey ? 10 : event.altKey ? 0.1 : 1
      state._delta = deltaFn(factor)

      this.start(event)
      state._keyboardActive = true

      V.addTo(state._movement, state._delta)

      this.compute(event)
      this.emit()
    }
  }

  keyUp(event: KeyboardEvent) {
    if (!(event.key in KEYS_DELTA_MAP)) return

    this.state._keyboardActive = false
    this.setActive()
    this.compute(event)
    this.emit()
  }

  bind(bindFunction: any) {
    const device = this.config.device

    bindFunction(device, 'start', this.pointerDown.bind(this))
    if (this.config.pointerCapture) {
      bindFunction(device, 'change', this.pointerMove.bind(this))
      bindFunction(device, 'end', this.pointerUp.bind(this))
      bindFunction(device, 'cancel', this.pointerUp.bind(this))
    }
    bindFunction('key', 'down', this.keyDown.bind(this))
    bindFunction('key', 'up', this.keyUp.bind(this))

    if (this.config.filterTaps) {
      bindFunction('click', '', this.pointerClick.bind(this), { capture: true })
    }
  }
}

function persistEvent(event: React.PointerEvent | PointerEvent) {
  'persist' in event && typeof event.persist === 'function' && event.persist()
}
