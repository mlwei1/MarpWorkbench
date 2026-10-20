import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initToken } from './api/client'
import './styles/main.css'

// 启动前置：从 ?token= 读取一次性 token → sessionStorage → 清理地址栏（契约 §2.1）
initToken()

createApp(App).use(router).mount('#app')
