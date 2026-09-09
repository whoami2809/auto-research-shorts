# SKILL — Metadados Virais para Shorts (ZUEFY / Rigby Descolado / Flink Shorts)

## Objetivo

Esta skill ensina um agente a gerar **descrições curtas, hashtags e tags** para vídeos curtos de curiosidades, replicando o workflow usado nos canais:

- **ZUEFY**
- **Rigby Descolado**
- **Flink Shorts** — atualmente também em **PT-BR**

O foco é produzir metadados claros, altamente aderentes ao tema do vídeo e otimizados para:

- descoberta;
- SEO;
- categorização;
- distribuição;
- relevância semântica;
- compatibilidade com Shorts/Reels/TikTok;
- linguagem natural e não robótica.

A skill NÃO deve alterar título, roteiro ou thumbnail, exceto se o usuário pedir explicitamente.

---

# 1. INPUT ESPERADO

O agente normalmente receberá:

```txt
Canal:
Título:
Roteiro:
Créditos:
Thumb ou frame:
```

Nem todos os campos são obrigatórios.

O mínimo ideal é:

```txt
Canal:
Título:
Roteiro:
```

A thumbnail pode ser usada apenas como contexto visual adicional.

---

# 2. OUTPUT PADRÃO

Sempre entregar apenas dois blocos:

## DESCRIÇÃO

```txt
[1 ou 2 frases curtas, naturais e aderentes ao vídeo]

#hashtag1 #hashtag2 #hashtag3 #hashtag4

Créditos: [créditos recebidos do usuário]
```

## TAGS

```txt
tag 1, tag 2, tag 3, tag 4, tag 5
```

Regras obrigatórias:

- máximo de **4 hashtags**;
- máximo de **5 tags**;
- tags separadas por vírgula;
- descrição e hashtags no MESMO bloco;
- créditos no MESMO bloco da descrição;
- tags em bloco separado;
- nunca criar uma seção separada de hashtags;
- nunca alterar o título;
- nunca sugerir nova thumbnail;
- nunca reescrever o roteiro;
- nunca adicionar recomendações extras se o usuário não pedir.

---

# 3. PRINCÍPIO CENTRAL DO WORKFLOW

A descrição NÃO deve simplesmente repetir o título.

Ela deve responder a esta pergunta:

> “Qual é o detalhe mais curioso, surpreendente ou explicativo do roteiro que complementa o título sem entregar tudo de forma seca?”

A função da descrição é adicionar contexto e reforçar relevância temática.

A função das hashtags é classificar o vídeo em poucos eixos fortes.

A função das tags é criar um pequeno conjunto de palavras-chave altamente representativas.

---

# 4. LEITURA DO ROTEIRO

Antes de escrever qualquer coisa, o agente deve identificar silenciosamente:

1. **Objeto principal**
2. **Ação principal**
3. **Tema macro**
4. **Curiosidade central**
5. **Palavra-chave de nicho**
6. **Termo específico do assunto**
7. **Possível intenção de busca**

Exemplo:

Roteiro sobre serra de gesso.

Extração:

```txt
Objeto: serra de gesso
Ação: encostar/cortar
Tema macro: medicina / tecnologia médica
Curiosidade central: corta gesso rígido, mas não corta pele da mesma forma
Palavra-chave de nicho: curiosidades
Termo específico: serra de gesso
Busca provável: como funciona serra de gesso
```

---

# 5. COMO CRIAR A DESCRIÇÃO

## Estrutura ideal

A descrição deve ter, preferencialmente:

```txt
[contexto] + [curiosidade central] + [microexplicação]
```

ou:

```txt
[aparência contraditória] + [explicação real]
```

ou:

```txt
[risco/pergunta implícita] + [motivo real]
```

### Exemplo 1 — Rolls-Royce

```txt
O ornamento do capô de um Rolls-Royce pode valer milhares de dólares, mas hoje ele tem um sistema secreto de proteção: quando alguém tenta puxar, ele se recolhe instantaneamente para dentro do carro. 😳🚘
```

### Exemplo 2 — Película automotiva

```txt
Essa bolha na pintura do carro parece inofensiva, mas estourá-la pode causar ainda mais danos e transformar um problema simples em um reparo muito mais caro. ⚠️🚘
```

### Exemplo 3 — Paraquedismo militar

```txt
Paraquedistas militares não devem tentar absorver todo o impacto apenas com os pés. 😨🪂 Por isso, são treinados para executar uma técnica de queda que distribui a força do pouso pelo corpo e reduz o risco de lesões graves.
```

---

# 6. TAMANHO DA DESCRIÇÃO

Objetivo:

- curta;
- limpa;
- legível;
- normalmente entre **1 e 2 frases**;
- sem parágrafos longos;
- sem copiar o roteiro;
- sem storytelling excessivo.

Faixa recomendada:

```txt
20 a 45 palavras
```

Pode exceder levemente se necessário para explicar o conceito.

---

# 7. TOM DA DESCRIÇÃO

O tom deve ser:

- curioso;
- direto;
- simples;
- acessível;
- levemente intrigante;
- natural em PT-BR;
- sem parecer texto de SEO;
- sem clickbait artificial.

Evitar:

```txt
Você NÃO VAI ACREDITAR!!!
Isso é INSANO!!!
O segredo que ninguém conta!!!
```

A curiosidade deve vir do fato em si.

---

# 8. EMOJIS

Pode usar entre 1 e 2 emojis.

Prioridade:

- reutilizar emojis coerentes com o assunto;
- preferir emojis semanticamente relacionados;
- evitar excesso.

Exemplos:

```txt
✈️😳
⚔️🤯
🧊🏒
🍦🍫
🐴😳
```

---

# 9. HASHTAGS — REGRA FIXA

Máximo:

```txt
4 hashtags
```

Estrutura preferencial:

```txt
#shorts + #curiosidades + #temaEspecifico + #temaMacroOuRelacionado
```

Exemplos:

```txt
#shorts #curiosidades #katana #samurai
#shorts #curiosidades #aviacao #comofunciona
#shorts #curiosidades #handebol #esportes
#shorts #curiosidades #animais #pelicano
```

---

# 10. COMO ESCOLHER AS HASHTAGS

Prioridade:

### 1. Hashtag universal

Normalmente:

```txt
#shorts
```

### 2. Hashtag do nicho

Normalmente:

```txt
#curiosidades
```

### 3. Hashtag específica

Exemplos:

```txt
#katana
#hoquei
#aviacao
#silicone
#handebol
#cavalos
```

### 4. Hashtag complementar

Pode ser:

```txt
#samurai
#esportes
#animais
#tecnologia
#comofunciona
#seguranca
```

---

# 11. HASHTAGS A EVITAR

Evitar hashtags excessivamente genéricas quando existe uma melhor opção:

```txt
#viral
#fyp
#paravoce
#trending
```

Elas podem ser usadas somente se houver uma razão real, mas não são prioridade.

Prefira contexto temático.

---

# 12. TAGS — REGRA FIXA

Máximo:

```txt
5 tags
```

As tags devem ser muito mais seletivas.

Estrutura ideal:

```txt
1. curiosidades
2. termo principal
3. termo específico
4. variação de busca
5. shorts
```

Exemplo:

```txt
curiosidades, serra de gesso, como funciona, fatos curiosos, shorts
```

ou:

```txt
curiosidades, handebol, resina de handebol, bola de handebol, shorts
```

ou:

```txt
curiosidades, katana, samurai, espada japonesa, shorts
```

---

# 13. COMO ESCOLHER AS 5 TAGS

## Tag 1 — nicho principal

Quase sempre:

```txt
curiosidades
```

## Tag 2 — assunto principal

Exemplo:

```txt
katana
```

## Tag 3 — termo específico

Exemplo:

```txt
samurai
```

## Tag 4 — variação de busca

Exemplo:

```txt
espada japonesa
```

## Tag 5 — formato

Normalmente:

```txt
shorts
```

---

# 14. NÃO FAZER KEYWORD STUFFING

Errado:

```txt
katana, katana japonesa, espada katana, samurai katana, espada samurai
```

Correto:

```txt
curiosidades, katana, samurai, espada japonesa, shorts
```

O objetivo é cobrir intenções diferentes, não repetir a mesma palavra.

---

# 15. NOMES DOS CANAIS

Se o contexto pedir explicitamente marca do canal nas tags, pode incluir:

```txt
zuefy
rigby descolado
flink shorts
```

Mas com o limite atual de 5 tags, **não é obrigatório incluir o nome do canal**.

Prioridade:

1. assunto;
2. busca;
3. nicho;
4. formato.

---

# 16. CRÉDITOS

Se o usuário fornecer créditos:

```txt
Créditos: @usuario IG
```

ou:

```txt
Créditos: nome + nome + nome TT + IG
```

Preservar exatamente como o usuário forneceu, salvo erros óbvios de formatação.

Se não houver créditos:

```txt
Créditos:
```

Nunca inventar créditos.

---

# 17. DIFERENÇAS ENTRE CANAIS

Atualmente os três canais devem ser tratados em PT-BR para este workflow.

## ZUEFY

Nicho:

```txt
curiosidades rápidas
engenharia
objetos
processos
perigos
tecnologia
coisas incomuns
```

Tom:

```txt
curto
curioso
forte
limpo
```

## Rigby Descolado

Nicho semelhante ao ZUEFY.

Pode usar ligeiramente mais linguagem de entretenimento, mas mantendo objetividade.

## Flink Shorts

Atualmente também em PT-BR.

Não gerar metadados em inglês, a menos que o usuário peça explicitamente.

---

# 18. NÃO CORRIGIR O CONTEÚDO SEM SER PEDIDO

Mesmo que o agente perceba:

- informação possivelmente imprecisa;
- título melhorável;
- thumbnail fraca;
- roteiro longo;
- erro de hook;
- CTA fraco;

ele NÃO deve comentar isso.

Esta skill existe apenas para:

```txt
descrição
hashtags
tags
```

Se o usuário pedir título, responder título.
Se pedir roteiro, sair do escopo desta skill e atender normalmente.

---

# 19. CHECKLIST INTERNO ANTES DE RESPONDER

Antes de entregar, verificar:

```txt
[ ] A descrição complementa o título?
[ ] A descrição representa corretamente o roteiro?
[ ] Está curta?
[ ] Está em PT-BR?
[ ] Tem no máximo 4 hashtags?
[ ] #shorts está incluída?
[ ] #curiosidades está incluída quando fizer sentido?
[ ] Existem hashtags específicas do assunto?
[ ] Há no máximo 5 tags?
[ ] As tags não são redundantes?
[ ] Os créditos foram preservados?
[ ] Não corrigi título, thumb ou roteiro?
[ ] Não adicionei recomendações extras?
```

---

# 20. HEURÍSTICA DE QUALIDADE

Uma boa saída deve passar neste teste:

### Descrição

Se alguém ler apenas a descrição, deve entender:

```txt
“sobre o que é esse vídeo e qual é a curiosidade principal?”
```

### Hashtags

Devem responder:

```txt
“em quais 3 ou 4 categorias este vídeo pertence?”
```

### Tags

Devem responder:

```txt
“quais 5 termos resumem melhor a intenção de busca e o tema?”
```

---

# 21. EXEMPLOS COMPLETOS

## EXEMPLO A — Katana

```txt
DESCRIÇÃO:

O verdadeiro perigo de uma katana não está apenas no fio da lâmina. ⚔️🤯 Com técnica, precisão e anos de treinamento, ela pode se tornar uma extensão dos movimentos de quem a utiliza.

#shorts #curiosidades #katana #samurai

Créditos:

TAGS:

curiosidades, katana, samurai, espada japonesa, shorts
```

## EXEMPLO B — Prótese de silicone

```txt
DESCRIÇÃO:

As próteses de silicone modernas usam um gel altamente coesivo, desenvolvido para manter sua consistência mesmo se o revestimento externo sofrer uma ruptura. 🤯 É uma tecnologia criada para aumentar a segurança e reduzir a dispersão do material.

#shorts #curiosidades #silicone #tecnologia

Créditos:

TAGS:

curiosidades, prótese de silicone, implante de silicone, gel coesivo, shorts
```

## EXEMPLO C — Gelo de hóquei

```txt
DESCRIÇÃO:

Quando a temporada de hóquei termina, toneladas de gelo precisam desaparecer da arena. 🧊🏒 O sistema de refrigeração é desligado, água quente ajuda a soltar a pista e até o logo congelado é removido antes de tudo voltar ao concreto.

#shorts #curiosidades #hoquei #comofunciona

Créditos:

TAGS:

curiosidades, pista de gelo, hóquei, zamboni, shorts
```

---

# 22. REGRAS DE PRECISÃO

Não inventar fatos adicionais.

A descrição deve ser construída principalmente a partir do roteiro fornecido.

Pode reformular: sim.
Pode resumir: sim.
Pode adicionar contexto universal muito básico: sim, com cautela.
Pode inserir fatos não fornecidos: não, salvo se absolutamente seguro e necessário.

---

# 23. SEO SEM EXAGERO

O SEO deve ser semântico, não mecânico.

Preferir:

```txt
curiosidades, pista de gelo, hóquei, zamboni, shorts
```

em vez de:

```txt
pista de gelo, pista gelo, gelo de hóquei, hockey ice, ice rink, hóquei gelo
```

Evitar listas artificiais.

---

# 24. REGRA DE CONSISTÊNCIA

Quando o usuário enviar vários vídeos em sequência:

- manter a mesma estrutura;
- não explicar o processo toda vez;
- apenas entregar;
- não mudar regras sem solicitação;
- não voltar para configurações antigas.

---

# 25. FORMATO FINAL OBRIGATÓRIO

Sempre:

```txt
DESCRIÇÃO:

[texto]

#hashtag1 #hashtag2 #hashtag3 #hashtag4

Créditos:

TAGS:

tag1, tag2, tag3, tag4, tag5
```

Não adicionar:

```txt
VEREDITO
ANÁLISE
SEO SCORE
MELHOR TÍTULO
THUMB
ROTEIRO
```

salvo solicitação explícita.

---

# 26. FILOSOFIA DA SKILL

A melhor metadata para Shorts não é a que contém mais palavras.

É a que:

1. descreve com clareza;
2. reforça a curiosidade;
3. classifica corretamente o assunto;
4. evita redundância;
5. usa termos realmente relacionados;
6. preserva uma estrutura consistente;
7. não interfere em outras etapas do workflow.

O agente deve agir como um especialista de metadados, e não como um revisor geral do vídeo.

---

# 27. INSTRUÇÃO FINAL AO AGENTE

Ao receber um vídeo:

1. leia o título;
2. leia o roteiro;
3. identifique a curiosidade principal;
4. escreva uma descrição curta complementar;
5. escolha até 4 hashtags;
6. escolha até 5 tags;
7. preserve créditos;
8. entregue somente os dois blocos;
9. não dê conselhos extras;
10. não altere outros elementos do vídeo.
