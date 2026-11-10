import { createRoot } from 'react-dom/client';
import App from './App';
import { initDeviceDiagnostics } from './utils/deviceDiagnostics';

// Opt-in device diagnostics (?diag=1). No-op otherwise.
initDeviceDiagnostics();

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
