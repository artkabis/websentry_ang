import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

void bootstrapApplication(AppComponent, appConfig).catch((err: unknown) => {
  console.error("Démarrage de l'application impossible :", err);
});
