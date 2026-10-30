import { Link } from "react-router-dom";

// Endereço exibido como contato na política — exigido pela Microsoft Store. Preencher antes de publicar.
const CONTACT_EMAIL = "contato@exemplo.com";
const LAST_UPDATED = "29 de outubro de 2026";

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
      </ul>

      <h2>O que não fazemos</h2>
      <ul>
        <li>Não vendemos nem compartilhamos dados com terceiros para publicidade.</li>
        <li>Não gravamos transmissões nem capturamos a tela sem você iniciar o compartilhamento.</li>
        <li>Não coletamos nome, e-mail ou contatos.</li>
      </ul>

      <h2>Quem vê sua transmissão</h2>
      <p>
        Qualquer pessoa com o link pode assistir. Salas públicas aparecem na lista de transmissões ao vivo; salas
        privadas não aparecem na lista, e salas com senha exigem a senha. Escolha o que compartilhar com cuidado.
      </p>

      <h2>Seus direitos</h2>
      <p>
        Você pode encerrar a transmissão a qualquer momento, o que remove os dados da sala. Para dúvidas ou pedidos
        relacionados à LGPD, escreva para <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <h2>Alterações</h2>
      <p>Mudanças nesta política serão publicadas nesta página, com a data de atualização acima.</p>

      <p className="privacy-back">
        <Link to="/">Voltar</Link>
      </p>
    </div>
  );
}
