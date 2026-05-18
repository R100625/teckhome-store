# TeckHome Store 🏠⚡

## Visão Geral
**TeckHome Store** é um site de review e curadoria de produtos para casa e tecnologia, com categorias organizadas e painel administrativo para gerenciar links de produtos.

## Funcionalidades Implementadas ✅
- **Página inicial** com hero, busca global, categorias visuais, destaques e recentes
- **7 categorias** de produtos: Eletrônicos, Eletrodomésticos, Ferramentas Elétricas, Refrigeração, Cama e Mesa, Ventilação, Jardim
- **Página de categoria** com filtros (todos/destaques) e busca local
- **Painel Admin** com:
  - Cola o link → busca metadados automaticamente (título, imagem, preço, loja)
  - Suporte a Amazon, Mercado Livre, Shopee, Magazine Luiza e mais
  - Marcar/desmarcar produto como Destaque ⭐
  - Remover produtos
  - Filtrar por categoria
- **Design responsivo** com Tailwind CSS
- **Animações** e feedback visual (toasts, shimmer loading, hover effects)

## URLs / Rotas
| Rota | Descrição |
|------|-----------|
| `/` | Página inicial |
| `/categoria/:id` | Página de categoria (ex: `/categoria/eletronicos`) |
| `/admin` | Painel administrativo |
| `/api/categories` | GET - Lista todas as categorias |
| `/api/products` | GET - Lista todos os produtos |
| `/api/products/:categoryId` | GET - Produtos de uma categoria |
| `/api/products` | POST - Adicionar produto |
| `/api/products/:cat/:id` | DELETE - Remover produto |
| `/api/products/:cat/:id/featured` | PATCH - Toggle destaque |
| `/api/fetch-metadata` | POST - Buscar metadados de URL |

## Categorias Disponíveis
- `eletronicos` - 💻 Eletrônicos
- `eletrodomesticos` - 🏠 Eletrodomésticos
- `ferramentas` - 🔧 Ferramentas Elétricas
- `refrigeracao` - ❄️ Refrigeração
- `cama-mesa` - 🛏️ Cama e Mesa
- `ventilacao` - 🌀 Ventilação
- `jardim` - 🌿 Jardim

## Como Usar (Admin)
1. Acesse `/admin`
2. Cole o link do produto no campo de URL
3. Clique em **"Buscar"** para preencher automaticamente título, imagem, preço e loja
4. Selecione a **categoria**
5. Opcionalmente marque como **Destaque** (aparece na página inicial)
6. Clique em **"Adicionar Produto"**

## Arquitetura
- **Backend**: Hono (TypeScript) no Cloudflare Pages/Workers
- **Frontend**: HTML/CSS/JS com Tailwind CSS (CDN)
- **Persistência**: Cloudflare KV (produção) / In-memory (desenvolvimento local)
- **Build**: Vite + @hono/vite-build

## Deploy
- **Plataforma**: Cloudflare Pages
- **Status**: ✅ Em desenvolvimento local
- **Stack**: Hono + TypeScript + TailwindCSS
- **Última atualização**: 2026-05-18
