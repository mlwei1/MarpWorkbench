/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  MarpCoreBundle?: {
    MarpCore: {
      Marp: any
      browser: (target?: ParentNode) => any
    }
  }
}
