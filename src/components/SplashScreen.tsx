import { useEffect, useRef, useState } from "react";
import { APP_AUTHOR, APP_NAME, getAppVersion } from "../lib/appinfo";
import { BrandMark } from "./BrandMark";

type Props = {
  isReady: boolean;
  onFinish: () => void;
};

export function SplashScreen({ isReady, onFinish }: Props) {
  const [version, setVersion] = useState("0.1.0");
  const mountedAt = useRef(Date.now());
  const finished = useRef(false);

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  useEffect(() => {
    const MIN_MS = 1200;
    const MAX_MS = 2800;
    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      onFinish();
    };
    const safety = window.setTimeout(finish, MAX_MS);
    let minimum: number | undefined;
    if (isReady) minimum = window.setTimeout(finish, Math.max(0, MIN_MS - (Date.now() - mountedAt.current)));
    return () => {
      window.clearTimeout(safety);
      if (minimum !== undefined) window.clearTimeout(minimum);
    };
  }, [isReady, onFinish]);

  return (
    <div className="splash-screen" role="dialog" aria-label={`Avvio di ${APP_NAME}`}>
      <img className="splash-image" src="/splash.svg" alt="" draggable={false} />
      <div className="splash-content" data-tauri-drag-region>
        <div className="splash-brand" data-tauri-drag-region>
          <BrandMark className="splash-mark" />
          <div data-tauri-drag-region>
            <div className="splash-wordmark" data-tauri-drag-region>
              <span className="brand-helm">helm</span><span className="brand-code">code</span>
            </div>
            <p className="splash-tagline">Spazio al tuo codice.</p>
          </div>
        </div>
        <div className="splash-footer" data-tauri-drag-region>
          <div className="splash-details"><span>Versione {version}</span><span>{APP_AUTHOR}</span></div>
          <div className="splash-status" role="status">
            <span>Preparazione dello spazio di lavoro</span>
            <div className="splash-loader" aria-hidden="true"><span /></div>
          </div>
        </div>
      </div>
    </div>
  );
}
