# Frequência

## Baixar para Android

[![Baixar APK — Frequência](https://img.shields.io/badge/BAIXAR%20APK-Frequ%C3%AAncia%20para%20Android-5B21B6?style=for-the-badge&logo=android&logoColor=white)](https://github.com/NyzzNew/Frequ-ncia-/releases/latest/download/Frequencia-0.1.0.apk)

[Ver a página de versões e notas de instalação](https://github.com/NyzzNew/Frequ-ncia-/releases/latest)

> **Versão de teste:** o botão só disponibiliza um arquivo depois que o GitHub Actions compila, verifica e publica o APK na página Releases. O repositório está privado; outras pessoas precisam de acesso autorizado para baixar.


App de comunidades para Android, com servidores privados, canais de texto e salas de voz. Interface em português inspirada no mockup do servidor **Os Crias**.

Todos os recursos desta versão são liberados para todas as contas. O projeto pode rodar num computador da própria comunidade. A disponibilidade de um servidor na internet depende da infraestrutura que o hospeda.

## Instalar e abrir

- Instale o APK em um aparelho com Android 9 ou superior com o Android System WebView atualizado. A versão de teste cobre ARM de 32 e 64 bits e emuladores x86_64.
- Toque em **Experimentar Os Crias** para testar os canais, as mensagens e o perfil de demonstração. Essa conversa fica no SQLite do aparelho.
- Para usar com amigos, toque em **Conectar a um servidor**, informe o endereço e crie uma conta. Cada aparelho precisa apontar para o mesmo servidor. Use o botão **Adicionar servidor** para criar sua comunidade e, no menu de canais, gere um **Convite**.
- Na aba **Amigos**, adicione alguém pelo @usuário. Depois de aceitar o pedido, os dois podem abrir mensagens diretas e entrar na chamada da conversa. Os dois precisam abrir a mesma sala para se encontrar.
- Na chamada, toque para ligar o microfone ou a câmera. **Compartilhar tela** abre a confirmação do Android. **Voltar ao chat** deixa a chamada ativa. **Sair** encerra a chamada. O app publica a imagem da tela e o áudio do microfone em trilhas separadas. O áudio interno de jogos e outros apps está fora desta versão.
- Em **Perfil**, escolha uma cor, envie um avatar ou banner (incluindo GIF animado, até 2 MiB e 2048 × 2048 px) e, se desejar, selecione até 1080p para compartilhamento nas próximas chamadas. O padrão é 720p. A resolução efetiva depende do aparelho e da rede.

## Rodar o servidor na mesma rede Wi-Fi

1. No computador, instale Docker com o comando `docker compose` e abra um terminal na pasta do projeto.
2. Copie `.env.example` para `.env`. Troque `LAN_IP` pelo IPv4 local do computador. Preencha `LIVEKIT_API_SECRET` com uma senha aleatória de pelo menos 32 caracteres. Para limitar novos cadastros, preencha `REGISTRATION_KEY` com outro código e entregue o código aos convidados.
3. Execute `docker compose up -d --build`. O backend salva contas, canais, histórico e arquivos no volume `db`.
4. Nos celulares na mesma rede, conecte com `http://IP_DO_PC:8787`. Se o firewall perguntar, permita conexões da rede privada nas portas TCP 8787, 7880 e 7881 e UDP 7882.
5. Para desligar, use `docker compose stop`. O servidor só fica disponível enquanto o computador está ligado. Preserve o volume `db` e faça backups com o serviço parado.

O Compose incluído é para teste na rede privada. Para publicar na internet, configure HTTPS para a API e WSS para a sinalização de mídia, use um domínio ou IP público e configure as portas de mídia e o TURN de acordo com a rede. Informe a origem WSS em `LIVEKIT_URL`; a chave e o segredo da API devem coincidir com a instância LiveKit. O APK aceita HTTP/WS somente com endereços locais. Proteja o cadastro e configure limites, backup e moderação antes de abrir o serviço ao público.

### Rodar apenas o chat no computador

Com Node.js 24, execute `node server/server.mjs`. O padrão é `127.0.0.1:8787`. Para celulares da mesma rede, defina `HOST=0.0.0.0` e conecte ao IP local. Para chamadas, adicione a instância LiveKit e defina as três variáveis `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` no backend. Sem elas, o chat permanece disponível e a tela de chamadas avisa que falta configurar a voz.

## Compilar e testar

Com JDK 17, Android SDK 35 e Build Tools 35.0.0 instalados:

```sh
./gradlew :app:assembleDebug
node --test server/server.test.mjs
```

No Windows, use `gradlew.bat :app:assembleDebug`. O APK de desenvolvimento sai em `app/build/outputs/apk/debug/app-debug.apk`. No GitHub, a aba **Actions → Frequência Android** publica o APK de teste como artefato após cada compilação bem-sucedida. Android exige o mesmo certificado para instalar uma atualização por cima de uma cópia existente.

Para uma distribuição definitiva, configure sua própria chave de assinatura nas variáveis `FREQUENCIA_KEYSTORE`, `FREQUENCIA_STORE_PASSWORD`, `FREQUENCIA_KEY_ALIAS` e `FREQUENCIA_KEY_PASSWORD`, e rode `./gradlew :app:assembleRelease`. Guarde o keystore fora do repositório.

## Escopo da versão 0.1

- Cadastro e login, servidores por convite, canais de texto e voz, permissões de dono/admin/membro, lista de membros, pedidos de amizade e DMs.
- Envio, edição, exclusão, busca por canal, reações, mensagens fixadas e anexos até 100 MiB por arquivo. O limite total de armazenamento pode ser ajustado no servidor.
- Chamada em sala e por DM com microfone, câmera, compartilhamento de tela e vídeo WebRTC pelo LiveKit.
- Perfis com bio, cor do app, avatar e banner. GIFs animados e qualidade de tela até 1080p estão disponíveis gratuitamente.
- Esta versão é voltada a grupos pequenos. Ainda faltam equivalentes a bots, mensagens de voz gravadas, notificações push e figurinhas/emoji personalizados de servidores. O chat busca atualizações enquanto está aberto.
