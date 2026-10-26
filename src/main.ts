import './styles.css';
import { Game } from './game/Game';

const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const bar = loading.querySelector<HTMLElement>('.loading-fill')!;
const label = loading.querySelector<HTMLElement>('.loading-label')!;

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
    label.textContent = 'Не удалось загрузить игру. Подробности в консоли (F12).';
    loading.classList.add('loading-error');
  });
