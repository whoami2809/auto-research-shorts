# Downloads adicionais no app principal

Solicitados pelo usuário em 23/09/2026: Xiaohongshu, Reddit e Pinterest.

- Escopo: `/api/video-dl` (individual e lote) e parser de links do modal do app.
- Não altera a autorização ou os bloqueios das etapas do workflow/CLI.
- Domínios exatos em `download-sites.js`; `in.pinterest.com` é normalizado para a publicação equivalente em `www.pinterest.com`.
- `xhslink.cn` é expandido somente por redirecionamentos HTTP, com HTTPS, DNS público fixado, timeout e destinos da mesma plataforma. Parâmetros necessários da publicação são preservados.
- Os novos sites usam somente seu extrator específico; conteúdo incorporado não habilita extratores genéricos/terceiros.
- A autorização por domínio não comprova direitos sobre a mídia nem implementa isolamento completo de rede do yt-dlp, verificação de cada CDN ou antimalware. As limitações anteriores continuam aplicáveis.

Validação inicial: os três links fornecidos pelo usuário retornaram títulos e formatos reais em consulta local sem download de mídia. Testes offline cobrem parser, isolamento do workflow, hosts falsificados, HTTPS, credenciais, portas, DNS privado, redirecionamentos externos, loops e timeout. Essa consulta não substitui um download completo no servidor publicado.
