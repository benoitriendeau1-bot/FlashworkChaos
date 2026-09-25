import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import RunList from './views/RunList.vue';
import RunDetail from './views/RunDetail.vue';
import ActionDetail from './views/ActionDetail.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'runs', component: RunList },
    { path: '/runs/:runId', name: 'run', component: RunDetail },
    { path: '/runs/:runId/actions/:actionId', name: 'action', component: ActionDetail },
  ],
});

createApp(App).use(router).mount('#app');
