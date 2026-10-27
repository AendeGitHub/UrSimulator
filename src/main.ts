import './styles.css';
import { Game, loadSettings } from './game/Game';
import { setLanguage, t } from './ui/i18n';

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const bar = loading.querySelector<HTMLElement>('.loading-fill')!;
const label = loading.querySelector<HTMLElement>('.loading-label')!;
// The saved language before anything is drawn (the hall banners are made while loading).
setLanguage(loadSettings().language);
label.textContent = t('loading.field');

Game.create(app, p => {
  bar.style.width = `${Math.round(p * 100)}%`;
})
  .then(game => {
    loading.remove();
    // Dev-only handle for debugging from the browser console.
    if (import.meta.env.DEV) Object.assign(window, { ursim: game });
  })
  .catch(err => {
    console.error(err);
    label.textContent = t('loading.failed');
    loading.classList.add('loading-error');
  });
