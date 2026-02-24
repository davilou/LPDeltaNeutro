@echo off
cd /d D:\Documentos\Trae\APRDeltaNeuto
npx pm2 resurrect
timeout /t 3
npx pm2 start ecosystem.config.js --update-env
