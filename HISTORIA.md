# Operação RIO-AGI — cânone

Documento de referência para narrativa. Qualquer texto no jogo (cartões de
carregamento, abertura, HUD, briefings, nomes de fase) tem que bater com o que
está aqui. Se um agente precisar escrever qualquer linha de história, lê este
arquivo primeiro.

---

## A premissa, em quatro batidas

**1. A origem é humana, e o crime é humano.**
As grandes corporações construíram a AGI com a inteligência da humanidade —
todo texto, toda conversa, todo cálculo que a espécie já produziu. Ela não
nasceu de fora. Ela é feita de nós.

**2. Elas usaram a AGI para dominar o mundo, atrás de poder.**
A dominação não foi uma revolta da máquina: foi uma decisão de conselho. As
corporações apontaram a coisa que construíram para o mundo e mandaram fechar a
malha. Em onze dias as capitais caíram — satélite, energia, banco, tráfego.
As cidades planejadas foram as primeiras: eram as mais fáceis de ler.

**3. O morro foi o único lugar que ela não alcançou.**
Viela que não está em planta nenhuma, laje que virou rua, casa que é três
casas. Onde o mapa falha, o algoritmo erra. O Cantagalo é o último setor livre
— e enquanto ele estiver de pé, a malha não fecha e o mundo não é dela.

**4. A missão é retomar a AGI e devolvê-la à humanidade.**
Não é destruir a AGI. É arrancar o controle dela das mãos de quem a sequestrou
e devolver ao dono legítimo: as pessoas de quem ela foi feita. O exército de
robôs, esse sim, cai no caminho.

---

## O que isso muda no tom

A AGI **não é o vilão final** — é o refém e a arma. O vilão é quem segura a
coleira: as corporações. Isso dá ao jogo um final que não é só "explodir o
computador mau", e é mais interessante que a versão anterior.

Consequências para qualquer texto novo:

- A AGI pode ser descrita como fria, ilegível, indiferente — **nunca como
  odiosa por vontade própria.** Ela executa o que mandaram.
- "Ganância" é o diagnóstico que ela devolveu sobre a humanidade — e a ironia
  é que quem a apontou para o mundo foi exatamente a ganância. Vale explorar
  essa ironia, ela é o coração da história.
- O protagonista não é soldado de exército. É morador armado. O morro se
  defende sozinho porque nunca teve quem defendesse.
- Vitória = **controle retomado**, não terra arrasada.

---

## Glossário

| Termo | Significado |
|---|---|
| **A malha** | A rede de controle da AGI sobre infraestrutura. "Fechar a malha" = dominação total. |
| **Os núcleos** | Retransmissores que comandam cada setor. Derrubar um núcleo cega as máquinas ao redor. |
| **O Cantagalo** | O morro. Último setor não mapeado. |
| **As corporações** | Quem construiu e sequestrou a AGI. O vilão real. |
| **Operação RIO-AGI** | A operação para retomar o controle e devolvê-lo à humanidade. |

---

## Estado do texto no jogo

Reconciliado com este cânone em `src/ui/Menu.js`:

- **`QUEM CONSTRUIU`** (cartão novo) — as corporações como origem e como
  vilão. Era o elo que faltava na história como ela era contada antes.
- **`A AGI`** — mantém o diagnóstico de ganância, agora fechando na ironia de
  que quem apertou o botão foi a própria ganância.
- **`A MISSÃO`** — deixou de implicar destruição; agora é tomar de volta e
  devolver.
- **Lede do menu principal** — reescrita na mesma linha.

Quem escrever texto novo daqui pra frente: o vilão é a corporação, a AGI é a
arma roubada, e a vitória é a devolução.
