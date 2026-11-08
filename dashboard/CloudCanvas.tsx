import { useEffect, useRef } from 'react'

const vertexSource = `
attribute vec3 position;
attribute vec3 color;
uniform float pointSize;
varying vec3 rgb;
void main() {
  gl_Position = vec4(position, 1.0);
  gl_PointSize = pointSize;
  rgb = color;
}`

const fragmentSource = `
precision mediump float;
varying vec3 rgb;
void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  if (dot(offset, offset) > 0.25) discard;
  gl_FragColor = vec4(rgb, 1.0);
}`

function shader(gl: WebGLRenderingContext, type: number, source: string) {
  const compiled = gl.createShader(type)
  if (!compiled) return null
  gl.shaderSource(compiled, source)
  gl.compileShader(compiled)
  if (gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) return compiled
  gl.deleteShader(compiled)
  return null
}

function renderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl', { alpha: true, depth: true })
  if (!gl) return null
  const vertex = shader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = shader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  const dispose = () => {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
  }
  if (!vertex || !fragment || !program || !buffer) { dispose(); return null }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null }
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  const position = gl.getAttribLocation(program, 'position')
  const color = gl.getAttribLocation(program, 'color')
  gl.enableVertexAttribArray(position)
  gl.enableVertexAttribArray(color)
  gl.vertexAttribPointer(position, 3, gl.FLOAT, false, 24, 0)
  gl.vertexAttribPointer(color, 3, gl.FLOAT, false, 24, 12)
  const pointSize = gl.getUniformLocation(program, 'pointSize')
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LEQUAL)
  return {
    draw(vertices: Float32Array, frameWidth: number) {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const scale = Math.min(width / frameWidth, height / 420)
      const viewWidth = Math.max(1, Math.round(frameWidth * scale))
      const viewHeight = Math.max(1, Math.round(420 * scale))
      gl.viewport(Math.floor((width - viewWidth) / 2), Math.floor((height - viewHeight) / 2), viewWidth, viewHeight)
      gl.uniform1f(pointSize, Math.max(2 * ratio, 3 * scale))
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
      gl.drawArrays(gl.POINTS, 0, vertices.length / 6)
    },
    dispose,
  }
}

export function CloudCanvas({ vertices, frameWidth, onFallback }: {
  vertices: Float32Array
  frameWidth: number
  onFallback: (fallback: boolean) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const context = useRef<ReturnType<typeof renderer>>(null)
  const latest = useRef({ vertices, frameWidth })
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const initialize = () => {
      context.current = renderer(element)
      onFallback(!context.current)
      context.current?.draw(latest.current.vertices, latest.current.frameWidth)
    }
    const lost = (event: Event) => {
      event.preventDefault()
      context.current = null
      onFallback(true)
    }
    initialize()
    const observer = new ResizeObserver(() => context.current?.draw(latest.current.vertices, latest.current.frameWidth))
    observer.observe(element)
    element.addEventListener('webglcontextlost', lost)
    element.addEventListener('webglcontextrestored', initialize)
    return () => {
      observer.disconnect()
      element.removeEventListener('webglcontextlost', lost)
      element.removeEventListener('webglcontextrestored', initialize)
      context.current?.dispose()
      context.current = null
    }
  }, [onFallback])
  useEffect(() => {
    latest.current = { vertices, frameWidth }
    context.current?.draw(vertices, frameWidth)
  }, [vertices, frameWidth])
  return <canvas ref={canvas} className="cloud" aria-hidden="true" />
}
