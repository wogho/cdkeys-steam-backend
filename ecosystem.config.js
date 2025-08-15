module.exports = {
  apps: [{
    name: 'cdkeys-steam',
    script: './server.js',
    env: {
      PORT: 3000,
      HOST: '0.0.0.0',
      NODE_OPTIONS: '--dns-result-order=ipv4first'
    }
  }]
};
