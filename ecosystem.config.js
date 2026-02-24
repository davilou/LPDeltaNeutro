module.exports = {
  apps: [
    {
      name: 'apr-delta-neuto',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 50,
      min_uptime: '10s',        // reinicio falha se morrer antes de 10s
      restart_delay: 5000,      // espera 5s antes de reiniciar
      env: {
        NODE_ENV: 'production',
      },
      // PM2 gerencia os logs — não sobrescreve o winston
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
