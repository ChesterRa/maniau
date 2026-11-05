import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AnswerRoot } from './answer';
import './i18n';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root が無い');
// 答えるリンクの頁（家の外の人）は、家族の画面とは別に作る（家族の見る口・セッションを読まない）。
const answering = window.location.pathname === '/answer';
createRoot(root).render(<StrictMode>{answering ? <AnswerRoot /> : <App />}</StrictMode>);
