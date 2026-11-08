import { Link } from "react-router-dom";

// Contato exibido na política (exigido pela Microsoft Store) — definido no build via VITE_CONTACT_EMAIL.
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? "";
const LAST_UPDATED = "8 de novembro de 2026";

export function PrivacyPage() {
  return (
    <div className="privacy-page">
      <h1>Política de Privacidade</h1>
      <p className="privacy-updated">Última atualização: {LAST_UPDATED}</p>

      <p>
        O Screen Share (aplicativo para Windows e site para espectadores) serve só para transmitir a tela em tempo
        real. Não exige conta, não grava transmissões e não usa rastreamento nem publicidade.
      </p>

      <h2>O que é tratado</h2>
      <ul>
        <li>
          <strong>Vídeo e áudio da transmissão:</strong> o conteúdo da tela ou janela escolhida (e o áudio, se você
          ativar) é enviado em tempo real aos espectadores, passando pelos nossos servidores de mídia. Nada é gravado
          ou armazenado.
        </li>
        <li>
          <strong>Dados da sala:</strong> nome/link da sala, configurações (resolução, FPS, privacidade) e, se
          definida, a senha. Ficam só na memória do servidor e são apagados poucos minutos depois que a transmissão
          termina.
        </li>
        <li>
          <strong>Dados técnicos de conexão:</strong> endereço IP e informações de rede necessárias para estabelecer a
          conexão de vídeo (WebRTC/TURN). Os servidores registram acessos (IP, data, rota) em logs técnicos usados
          apenas para segurança e diagnóstico.
        </li>
        <li>
          <strong>Diagnóstico de qualidade:</strong> ao fim de cada transmissão (ou quando uma falha é detectada), o
          aplicativo e o site enviam contadores técnicos anônimos — versão, duração, codec, quadros enviados, tipo de
          conexão. Não incluem o conteúdo da tela nem dados pessoais e são apagados após 90 dias.
        </li>
        <li>
          <strong>Relatórios de erro do aplicativo:</strong> se o aplicativo para Windows fechar por erro, ele envia um
          relatório técnico (versão e o estado do programa no momento do erro) para corrigirmos o problema. O
          relatório pode conter trechos da memória do aplicativo. Você pode desligar o envio no menu do ícone da
          bandeja, em "Enviar relatórios de erro". Os relatórios são apagados após 90 dias.
        </li>
        <li>
          <strong>Avisos pelo Discord (opcional):</strong> quem se inscreve no bot do Discord (botão ou{" "}
          <code>/avisar</code>) recebe uma mensagem direta quando uma transmissão pública começa. Para isso guardamos
          apenas o ID da sua conta do Discord, até você cancelar com <code>/parar</code> ou o botão "Parar de
          receber" — o que apaga o ID na hora.
        </li>
        <li>
          <strong>Apelido de quem transmite (opcional):</strong> no aplicativo para Windows (em "Configuração") e ao
          transmitir pelo site, você pode definir um apelido — no aplicativo, ele pode ser sugerido a partir do nome
          da sua conta do Discord aberta no computador. Ele fica salvo só no seu dispositivo e só é enviado se você ligar "Mostrar meu nome no aviso do
          Discord" — nesse caso aparece no aviso enviado aos inscritos e fica na memória do servidor junto com os
          dados da sala, sendo apagado quando ela termina. O aplicativo não acessa sua conta do Discord além desse
          nome, não faz login e não guarda senha nem token.
        </li>
        <li>
          <strong>Status no Discord:</strong> enquanto você transmite, o aplicativo para Windows mostra "Transmitindo
          tela" no seu perfil do Discord pelo próprio Discord instalado no computador. Quem vê esse status é
          controlado pelas configurações de privacidade do Discord ("Compartilhar sua atividade").
        </li>
      </ul>

      <h2>O que não fazemos</h2>
      <ul>
        <li>Não vendemos nem compartilhamos dados com terceiros para publicidade.</li>
        <li>Não gravamos transmissões nem capturamos a tela sem você iniciar o compartilhamento.</li>
        <li>
          Não coletamos e-mail nem contatos. Nome só é enviado no caso do apelido acima, se você escolher mostrá-lo.
        </li>
      </ul>

      <h2>Quem vê sua transmissão</h2>
      <p>
        Qualquer pessoa com o link pode assistir. Salas públicas aparecem na lista de transmissões ao vivo; salas
        privadas não aparecem na lista, e salas com senha exigem a senha. Escolha o que compartilhar com cuidado.
      </p>

      <h2>Seus direitos</h2>
      <p>
        Você pode encerrar a transmissão a qualquer momento, o que remove os dados da sala, desligar "Mostrar meu nome
        no aviso do Discord" a qualquer momento e cancelar os avisos do Discord com <code>/parar</code>. O Discord é
        um serviço de terceiros, com política de privacidade própria. Para dúvidas ou pedidos
        relacionados à LGPD, {CONTACT_EMAIL ? (
          <>
            escreva para <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </>
        ) : (
          "entre em contato pela página do aplicativo na Microsoft Store."
        )}
      </p>

      <h2>Alterações</h2>
      <p>Mudanças nesta política serão publicadas nesta página, com a data de atualização acima.</p>

      <p className="privacy-back">
        <Link to="/">Voltar</Link>
      </p>
    </div>
  );
}
