import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ServicesProvider } from './app/services';
import './index.css';
import { ThemeProvider } from './theme/ThemeProvider';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ServicesProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ServicesProvider>
    </ThemeProvider>
  </StrictMode>,
);
